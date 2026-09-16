package server

import (
	"net/http/httptest"
	"testing"
)

func TestClientIPTrustBoundary(t *testing.T) {
	for _, tc := range []struct {
		name, trusted, peer, forwarded, want string
	}{
		{"direct spoof", "", "192.0.2.10:9000", "198.51.100.2", "192.0.2.10"},
		{"untrusted proxy", "127.0.0.1", "192.0.2.10:9000", "198.51.100.2", "192.0.2.10"},
		{"trusted proxy", "127.0.0.1", "127.0.0.1:9000", "198.51.100.2", "198.51.100.2"},
		{"forged prefix", "127.0.0.1", "127.0.0.1:9000", "203.0.113.1, 198.51.100.2", "198.51.100.2"},
		{"trusted chain", "127.0.0.1,10.0.0.0/24", "127.0.0.1:9000", "203.0.113.1, 198.51.100.2, 10.0.0.5", "198.51.100.2"},
		{"invalid header", "127.0.0.1", "127.0.0.1:9000", "garbage,198.51.100.2", "127.0.0.1"},
		{"mapped IPv4", "127.0.0.1", "[::ffff:192.0.2.10]:9000", "198.51.100.2", "192.0.2.10"},
		{"IPv6 subnet", "", "[2001:db8:1:2::123]:9000", "", "2001:db8:1:2::/64"},
		{"forwarded IPv6", "::1", "[::1]:9000", "2001:db8:1:2::456", "2001:db8:1:2::/64"},
		{"missing peer", "", "invalid", "198.51.100.2", "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			trusted, err := ParseTrustedProxies(tc.trusted)
			if err != nil {
				t.Fatal(err)
			}
			s := &Server{TrustedProxies: trusted}
			req := httptest.NewRequest("POST", "/api/relay", nil)
			req.RemoteAddr = tc.peer
			req.Header.Set("X-Forwarded-For", tc.forwarded)
			req.Header.Set("X-Real-IP", "203.0.113.99")
			req.Header.Set("Forwarded", "for=203.0.113.99")
			if got := s.clientIP(req); got != tc.want {
				t.Fatalf("got %q; want %q", got, tc.want)
			}
		})
	}
}

func TestTrustedProxyConfigurationAndMultipleHeaders(t *testing.T) {
	for _, value := range []string{"proxy.example.com", "10.0.0.0/33", "::ffff:10.0.0.1/80", "fe80::1%eth0"} {
		if _, err := ParseTrustedProxies(value); err == nil {
			t.Errorf("invalid proxy accepted: %s", value)
		}
	}
	prefixes, err := ParseTrustedProxies("127.0.0.1/32, ::ffff:10.0.0.1/120\n::1")
	if err != nil || len(prefixes) != 3 || prefixes[1].String() != "10.0.0.0/24" {
		t.Fatalf("incorrect normalization: %v %v", prefixes, err)
	}
	s := &Server{TrustedProxies: prefixes}
	req := httptest.NewRequest("POST", "/api/relay", nil)
	req.RemoteAddr = "127.0.0.1:9000"
	req.Header.Add("X-Forwarded-For", "203.0.113.1")
	req.Header.Add("X-Forwarded-For", "198.51.100.2")
	if got := s.clientIP(req); got != "198.51.100.2" {
		t.Fatal("multiple header fields changed the trust boundary:", got)
	}
}
