package relay

import (
	"net/netip"
	"testing"
)

func TestPublicUpstreamValidation(t *testing.T) {
	for _, value := range []string{"http://example.com/v1", "https://localhost/v1", "https://127.0.0.1/v1", "https://[::1]/v1", "https://10.0.0.1/v1", "https://169.254.169.254/latest", "https://user:pass@example.com/v1", "https://example.com/v1?key=secret", "https://example.com/v1#fragment"} {
		if _, err := Endpoint(value, false); err == nil {
			t.Errorf("accepted %s", value)
		}
	}
	endpoint, err := Endpoint("https://example.com/v1/", false)
	if err != nil || endpoint != "https://example.com/v1/chat/completions" {
		t.Fatalf("wrong endpoint: %s %v", endpoint, err)
	}
	for _, value := range []string{"127.0.0.1", "10.1.2.3", "100.64.0.1", "169.254.1.1", "192.0.2.1", "198.19.0.1", "224.0.0.1", "240.0.0.1", "::", "::1", "fc00::1", "fe80::1", "2001:db8::1", "::ffff:127.0.0.1", "64:ff9b::a00:1"} {
		if publicIP(netip.MustParseAddr(value)) {
			t.Errorf("accepted private/reserved IP %s", value)
		}
	}
	for _, value := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"} {
		if !publicIP(netip.MustParseAddr(value)) {
			t.Errorf("rejected public IP %s", value)
		}
	}
}
