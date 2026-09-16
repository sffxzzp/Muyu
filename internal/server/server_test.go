package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"subtitle-studio/internal/relay"
)

func testServer() *Server {
	return New(relay.NewClient(false), fstest.MapFS{"index.html": {Data: []byte("<html>embedded app</html>")}, "assets/app.js": {Data: []byte("console.log('app')")}}, 1)
}

func TestEmbeddedStaticAndAPIRouting(t *testing.T) {
	handler := testServer().Handler()
	for _, tc := range []struct {
		path     string
		status   int
		contains string
	}{
		{"/", 200, "embedded app"}, {"/workspace/task", 200, "embedded app"}, {"/assets/app.js", 200, "console.log"},
		{"/assets/missing.js", 404, "404"}, {"/api/health", 200, `"storage":"browser"`}, {"/api/missing", 404, "接口不存在"},
	} {
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, httptest.NewRequest("GET", tc.path, nil))
		if rr.Code != tc.status || !strings.Contains(rr.Body.String(), tc.contains) {
			t.Errorf("%s: %d %s", tc.path, rr.Code, rr.Body.String())
		}
		if rr.Header().Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(rr.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
			t.Fatal("missing response headers")
		}
	}
}

func TestRuntimeUIConfig(t *testing.T) {
	for _, language := range []string{"en", "zh-CN"} {
		t.Run(language, func(t *testing.T) {
			s := testServer()
			if s.DefaultUILanguage != "en" {
				t.Fatal("the default interface language must be English")
			}
			s.DefaultUILanguage = language
			rr := httptest.NewRecorder()
			s.Handler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/ui-config.js", nil))
			if rr.Code != http.StatusOK || rr.Header().Get("Content-Type") != "text/javascript; charset=utf-8" {
				t.Fatalf("invalid config response: %d %v", rr.Code, rr.Header())
			}
			if rr.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("runtime configuration must not be cached between deployments")
			}
			const prefix = "window.__MUYU_CONFIG__ = "
			body := rr.Body.String()
			if !strings.HasPrefix(body, prefix) || !strings.HasSuffix(body, ";\n") {
				t.Fatalf("invalid bootstrap script: %s", body)
			}
			var config map[string]string
			if err := json.Unmarshal([]byte(strings.TrimSuffix(strings.TrimPrefix(body, prefix), ";\n")), &config); err != nil {
				t.Fatal(err)
			}
			if len(config) != 1 || config["defaultUILanguage"] != language {
				t.Fatalf("unexpected public config: %v", config)
			}
		})
	}
}

func TestAPIRejectsCrossSiteAndInvalidBodies(t *testing.T) {
	handler := testServer().Handler()
	for _, tc := range []struct {
		name, contentType, origin, body string
		status                          int
	}{
		{"cross site", "application/json", "https://evil.invalid", `{}`, 403}, {"wrong type", "text/plain", "", `{}`, 415},
		{"unknown field", "application/json", "", `{"payload":{"model":"model","tools":[]}}`, 400},
		{"trailing data", "application/json", "", `{} {}`, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rr := httptest.NewRecorder()
			req := httptest.NewRequest("POST", "/api/relay", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", tc.contentType)
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			handler.ServeHTTP(rr, req)
			if rr.Code != tc.status {
				t.Fatalf("got %d, want %d", rr.Code, tc.status)
			}
		})
	}
}

func TestAPIConcurrencyLimit(t *testing.T) {
	s := testServer()
	handler := s.Handler()
	release, retryAfter := s.Limiter.acquireRequest("another-client")
	if retryAfter != 0 {
		t.Fatal("could not occupy the concurrency slot")
	}
	defer release()
	req := httptest.NewRequest("POST", "/api/relay", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != 429 || rr.Header().Get("Retry-After") == "" || !strings.Contains(rr.Body.String(), `"rateLimited":true`) {
		t.Fatal("concurrency limit missing")
	}
}
