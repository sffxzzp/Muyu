package relay

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

func validRequest() Request {
	tokens, temperature := 4096, 0.1
	return Request{BaseURL: "https://example.com/v1", APIKey: "secret-test-key", TimeoutSeconds: 30,
		Payload: Payload{Model: "test-model", MaxTokens: &tokens, Temperature: &temperature,
			Messages: []Message{{Role: "system", Content: "Translate."}, {Role: "user", Content: `{"cues":["<i>Hello.</i>"]}`}}}}
}

func TestRelaysPreparedMessagesAndRawResponseWithoutTranslationLogic(t *testing.T) {
	req := validRequest()
	const raw = `{"choices":[{"message":{"content":"the browser validates this"}}],"usage":{"total_tokens":180}}`
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer secret-test-key" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var payload Payload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || !reflect.DeepEqual(payload, req.Payload) {
			t.Errorf("payload changed: %+v %v", payload, err)
		}
		if r.Header.Get("Cookie") != "" || r.Header.Get("Referer") != "" {
			t.Error("unexpected browser credentials")
		}
		_, _ = w.Write([]byte(raw))
	}))
	defer upstream.Close()
	req.BaseURL = upstream.URL + "/v1/"
	result, err := NewClient(true).Forward(context.Background(), req)
	if err != nil || result.Status != 200 || string(result.Body) != raw {
		t.Fatalf("response changed: %+v %v", result, err)
	}
}

func TestUpstreamStatusAndRetryAfterArePreservedWithoutErrorBodies(t *testing.T) {
	for _, status := range []int{401, 429, 500} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Retry-After", "7")
				w.WriteHeader(status)
				_, _ = w.Write([]byte("secret-test-key raw provider error"))
			}))
			defer upstream.Close()
			req := validRequest()
			req.BaseURL = upstream.URL
			result, err := NewClient(true).Forward(context.Background(), req)
			if err != nil || result.Status != status || result.RetryAfter != "7" || len(result.Body) != 0 {
				t.Fatalf("unsafe or incorrect error response: %+v %v", result, err)
			}
		})
	}
}

func TestRedirectNeverForwardsCredentials(t *testing.T) {
	var hits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer target.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer upstream.Close()
	req := validRequest()
	req.BaseURL = upstream.URL
	result, err := NewClient(true).Forward(context.Background(), req)
	if err != nil || result.Status != 307 || len(result.Body) != 0 || hits.Load() != 0 {
		t.Fatalf("unsafe redirect: %+v %v hits=%d", result, err, hits.Load())
	}
}

func TestInvalidRequestsNeverReachAnUpstream(t *testing.T) {
	for name, change := range map[string]func(*Request){
		"streaming":           func(r *Request) { r.Payload.Stream = true },
		"missing token limit": func(r *Request) { r.Payload.MaxTokens = nil },
		"two token limits":    func(r *Request) { r.Payload.MaxCompletionTokens = r.Payload.MaxTokens },
		"tool role":           func(r *Request) { r.Payload.Messages[0].Role = "tool" },
		"oversized content":   func(r *Request) { r.Payload.Messages[0].Content = strings.Repeat("x", (512<<10)+1) },
		"unbounded timeout":   func(r *Request) { r.TimeoutSeconds = 181 },
		"header injection":    func(r *Request) { r.APIKey = "key\r\nX-Header: value" },
	} {
		t.Run(name, func(t *testing.T) {
			req := validRequest()
			change(&req)
			transport := &captureTransport{}
			client := NewClient(false)
			client.HTTP = &http.Client{Transport: transport}
			_, err := client.Forward(context.Background(), req)
			var apiErr *APIError
			if !errors.As(err, &apiErr) || apiErr.Status != 400 || transport.calls != 0 {
				t.Fatalf("invalid request reached transport: %v calls=%d", err, transport.calls)
			}
		})
	}
}

func TestResponseSizeAndCancellationRemainBounded(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", (2<<20)+1)))
	}))
	defer upstream.Close()
	req := validRequest()
	req.BaseURL = upstream.URL
	_, err := NewClient(true).Forward(context.Background(), req)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 502 || !apiErr.Retryable {
		t.Fatalf("unbounded response: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := NewClient(true).Forward(ctx, req); err == nil {
		t.Fatal("ignored request cancellation")
	}
}
