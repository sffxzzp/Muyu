package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"subtitle-studio/internal/relay"
)

func relayBody(base string) relay.Request {
	tokens := 4096
	return relay.Request{
		BaseURL: base, APIKey: "test-only-key", TimeoutSeconds: 30,
		Payload: relay.Payload{Model: "model", MaxTokens: &tokens, Messages: []relay.Message{{Role: "user", Content: "Hello."}}},
	}
}

func postJSON(t *testing.T, handler http.Handler, route, peer string, body any) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, route, bytes.NewReader(data))
	r.RemoteAddr = peer
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func assertThrottle(t *testing.T, response *httptest.ResponseRecorder, delay string) {
	t.Helper()
	var body struct {
		Retryable   bool `json:"retryable"`
		RateLimited bool `json:"rateLimited"`
		RetryAfter  int  `json:"retryAfter"`
	}
	if response.Code != 429 || response.Header().Get("Retry-After") != delay || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("invalid throttle response: %d %v %s", response.Code, response.Header(), response.Body)
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || !body.Retryable || !body.RateLimited || body.RetryAfter < 1 {
		t.Fatalf("invalid retry instructions: %+v %v", body, err)
	}
}

func TestHostLimitsApplyBeforeForwardingAcrossKeysPathsAndPorts(t *testing.T) {
	var hits atomic.Int32
	provider := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		content := `{"translations":[{"id":1,"text":"你好。"}],"glossary":[],"style_notes":""}`
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": content}, "finish_reason": "stop"}}})
	})
	one, two := httptest.NewServer(provider), httptest.NewServer(provider)
	defer one.Close()
	defer two.Close()
	client := relay.NewClient(true)
	var err error
	client.AllowedHosts, err = relay.ParseAPIHosts(strings.TrimPrefix(one.URL, "http://") + "," + strings.TrimPrefix(two.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	s := New(client, nil, 32)
	limits := DefaultLimits()
	limits.HostRPM = 1
	l, now := clockedLimiter(limits)
	s.Limiter = l
	handler := s.Handler()
	if w := postJSON(t, handler, "/api/relay", "192.0.2.1:1000", relayBody(one.URL+"/v1")); w.Code != 200 {
		t.Fatalf("allowed translation failed: %d %s", w.Code, w.Body)
	}
	req := relayBody(two.URL + "/another/path")
	req.APIKey = "different-test-key"
	w := postJSON(t, handler, "/api/relay", "192.0.2.2:1000", req)
	assertThrottle(t, w, "60")
	if hits.Load() != 1 {
		t.Fatal("rate-limited request reached the model")
	}
	*now = now.Add(time.Minute)
	if w := postJSON(t, handler, "/api/relay", "192.0.2.2:1000", req); w.Code != 200 || hits.Load() != 2 {
		t.Fatalf("translation did not resume after cooldown: %d %s", w.Code, w.Body)
	}
}

func TestBlockedUpstreamDoesNotConsumeHostQuota(t *testing.T) {
	s := testServer()
	s.Relay.AllowedHosts, _ = relay.ParseAPIHosts("api.deepseek.com")
	w := postJSON(t, s.Handler(), "/api/relay", "192.0.2.1:1000", relayBody("https://api.deepseek.com.attacker.invalid/v1"))
	if w.Code != 403 || !strings.Contains(w.Body.String(), `"retryable":false`) || len(s.Limiter.hosts) != 0 {
		t.Fatalf("blocked host accepted or consumed host quota: %d %s", w.Code, w.Body)
	}
}

type unreadableBody struct{}

func (unreadableBody) Read([]byte) (int, error) { panic("a throttled request body must not be read") }

func TestIPLimitsIgnoreSpoofedHeadersAndProtectAllPOSTRoutes(t *testing.T) {
	s := testServer()
	limits := DefaultLimits()
	limits.IPRPM = 1
	s.Limiter, _ = clockedLimiter(limits)
	handler := s.Handler()
	first := postJSON(t, handler, "/api/relay", "192.0.2.1:1000", map[string]string{})
	if first.Code != 400 {
		t.Fatal(first.Body)
	}
	for _, path := range []string{"/api/relay", "/api/unknown"} {
		r := httptest.NewRequest(http.MethodPost, path, unreadableBody{})
		r.RemoteAddr = "192.0.2.1:2000"
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Forwarded-For", "198.51.100.2")
		r.Header.Set("X-Real-IP", "198.51.100.2")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		assertThrottle(t, w, "60")
	}
	for _, path := range []string{"/", "/api/health", "/api/ui-config.js"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != 200 {
			t.Fatal("throttling blocked the page or health/config endpoint")
		}
	}
	// An unrelated visitor can still use an API endpoint.
	if w := postJSON(t, handler, "/api/relay", "198.51.100.2:1000", map[string]string{}); w.Code == 429 {
		t.Fatal("separate visitor shared the attacker's quota")
	}
}
