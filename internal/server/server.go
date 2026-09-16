package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/netip"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"subtitle-studio/internal/relay"
)

type Server struct {
	Relay             *relay.Client
	Static            fs.FS
	DefaultUILanguage string
	Limiter           *Limiter
	TrustedProxies    []netip.Prefix
}

func New(client *relay.Client, static fs.FS, concurrency int) *Server {
	if concurrency < 1 {
		concurrency = 32
	}
	limits := DefaultLimits()
	limits.GlobalConcurrency = concurrency
	return &Server{Relay: client, Static: static, DefaultUILanguage: "en", Limiter: NewLimiter(limits)}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "storage": "browser", "formats": []string{"srt", "vtt"}})
	})
	// A parser-blocking same-origin script supplies runtime defaults before the
	// first paint. Only public UI configuration is exposed, never other env vars.
	uiConfig, _ := json.Marshal(map[string]string{"defaultUILanguage": s.DefaultUILanguage})
	mux.HandleFunc("GET /api/ui-config.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		_, _ = io.WriteString(w, "window.__MUYU_CONFIG__ = "+string(uiConfig)+";\n")
	})
	mux.HandleFunc("POST /api/relay", s.relay)
	mux.HandleFunc("POST /api/translate", func(w http.ResponseWriter, r *http.Request) {
		fail(w, http.StatusGone, "页面已更新，请刷新后继续；已保存的翻译进度会保留")
	})
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		fail(w, http.StatusNotFound, "接口不存在")
	})
	mux.HandleFunc("/", s.static)
	return s.middleware(mux)
}

func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https: http:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
			if r.Method == http.MethodPost {
				release, retryAfter := s.Limiter.acquireRequest(s.clientIP(r))
				if retryAfter > 0 {
					throttle(w, retryAfter, "服务端请求过于频繁或并发已满，请稍后重试")
					return
				}
				defer release()
				origin := r.Header.Get("Origin")
				if origin != "" {
					u, err := url.Parse(origin)
					if err != nil || u.Host != r.Host || (u.Scheme != "http" && u.Scheme != "https") {
						fail(w, http.StatusForbidden, "不允许跨站请求")
						return
					}
				}
				if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
					fail(w, http.StatusForbidden, "不允许跨站请求")
					return
				}
				if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
					fail(w, http.StatusUnsupportedMediaType, "请求必须使用 application/json")
					return
				}
				r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
			}
		}
		next.ServeHTTP(w, r)
	})
}

func decode(w http.ResponseWriter, r *http.Request, target any) bool {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			fail(w, http.StatusRequestEntityTooLarge, "请求超过大小限制")
		} else {
			fail(w, http.StatusBadRequest, "请求数据无效或过大")
		}
		return false
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		fail(w, http.StatusBadRequest, "请求必须只包含一个 JSON 对象")
		return false
	}
	return true
}

func (s *Server) relay(w http.ResponseWriter, r *http.Request) {
	var req relay.Request
	if !decode(w, r, &req) {
		return
	}
	if err := req.Validate(); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	endpoint, err := s.Relay.Endpoint(req.BaseURL)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, relay.ErrHostNotAllowed) {
			status = http.StatusForbidden
		}
		fail(w, status, err.Error())
		return
	}
	release, retryAfter := s.Limiter.acquireHost(relay.UpstreamHost(endpoint))
	if retryAfter > 0 {
		throttle(w, retryAfter, "该模型服务的请求过于频繁或并发已满，请稍后重试")
		return
	}
	defer release()
	result, err := s.Relay.Forward(r.Context(), req)
	if err != nil {
		var apiErr *relay.APIError
		if errors.As(err, &apiErr) {
			writeJSON(w, apiErr.Status, map[string]any{"error": apiErr.Message, "retryable": apiErr.Retryable})
		} else {
			fail(w, http.StatusInternalServerError, "翻译请求处理失败")
		}
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Muyu-Upstream", "true")
	if result.RetryAfter != "" {
		w.Header().Set("Retry-After", result.RetryAfter)
	}
	w.WriteHeader(result.Status)
	_, _ = w.Write(result.Body)
}

func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.Static == nil {
		http.NotFound(w, r)
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	content, err := fs.ReadFile(s.Static, name)
	if err != nil && !strings.Contains(path.Base(name), ".") {
		name = "index.html"
		content, err = fs.ReadFile(s.Static, name)
	}
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if name == "index.html" || name == "ui-init.js" {
		w.Header().Set("Cache-Control", "no-cache")
	} else if strings.HasPrefix(name, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(content))
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func fail(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": message, "retryable": false})
}

func throttle(w http.ResponseWriter, retryAfter int, message string) {
	w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
	writeJSON(w, http.StatusTooManyRequests, map[string]any{
		"error": message, "retryable": true, "rateLimited": true, "retryAfter": retryAfter,
	})
}
