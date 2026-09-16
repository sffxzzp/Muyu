package relay

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
)

func TestHostAllowlistMatchesExactHostsAndPorts(t *testing.T) {
	list, err := ParseAPIHosts("API.Example.COM., api.deepseek.com:8443, 127.0.0.1:8000, [::1]:9443")
	if err != nil {
		t.Fatal(err)
	}
	client := NewClient(true)
	client.AllowedHosts = list
	for _, base := range []string{"https://api.example.com/v1", "https://API.EXAMPLE.COM.:443/v1", "https://api.example.com:00443", "https://api.deepseek.com:8443/v1", "http://127.0.0.1:8000/v1", "https://[::1]:9443"} {
		if _, err := client.Endpoint(base); err != nil {
			t.Errorf("allowed endpoint rejected: %s: %v", base, err)
		}
	}
	for _, base := range []string{"https://api.example.com.attacker.test", "https://evil-api.example.com", "https://sub.api.example.com", "https://api.example.com:8443", "http://api.example.com", "https://api.deepseek.com", "https://api.example.com@attacker.test", "https://api.example.com..", "https://api.example.com:0", "https://api.example.com:65536"} {
		if _, err := client.Endpoint(base); err == nil {
			t.Errorf("disallowed endpoint accepted: %s", base)
		}
	}
	endpoint, err := client.Endpoint("https://API.EXAMPLE.COM.:00443/v1/")
	if err != nil || endpoint != "https://api.example.com:443/v1/chat/completions" {
		t.Fatalf("endpoint not canonicalized: %s %v", endpoint, err)
	}
}

func TestAllowlistNeverDisablesNetworkSafety(t *testing.T) {
	for _, policy := range []string{"*", "localhost,127.0.0.1,[::1],169.254.169.254,10.0.0.1"} {
		list, err := ParseAPIHosts(policy)
		if err != nil {
			t.Fatal(err)
		}
		client := NewClient(false)
		client.AllowedHosts = list
		for _, base := range []string{"https://localhost", "https://127.0.0.1", "https://[::1]", "https://169.254.169.254", "https://10.0.0.1", "http://api.example.com"} {
			if _, err := client.Endpoint(base); err == nil {
				t.Errorf("allowlist disabled network restrictions: %s", base)
			}
		}
	}
	list, _ := ParseAPIHosts("")
	client := NewClient(false)
	client.AllowedHosts = list
	if _, err := client.Endpoint("https://example.com"); !errors.Is(err, ErrHostNotAllowed) {
		t.Fatal("an explicitly empty list must deny all hosts")
	}
	client.AllowedHosts, _ = ParseAPIHosts("*")
	if _, err := client.Endpoint("https://example.com"); err != nil {
		t.Fatal("explicit unrestricted mode rejected a public endpoint:", err)
	}
}

func TestMalformedHostAllowlistFailsClosed(t *testing.T) {
	for _, value := range []string{"https://api.example.com", "api.example.com/v1", "*.example.com", "*,api.example.com", "user@api.example.com", "api.example.com?key", "api.example.com?", "api.example.com#", "api.example.com:", "api.example.com:0", "api.example.com:65536", "api.example.com:abc", "api..example.com", "api.example.com..", "-api.example.com", "api_example.com", "字幕.example", "%65xample.com", strings.Repeat("a", 16385)} {
		if _, err := ParseAPIHosts(value); err == nil {
			t.Errorf("invalid policy accepted: %s", value)
		}
	}
}

type captureTransport struct{ calls int }

func (c *captureTransport) RoundTrip(*http.Request) (*http.Response, error) {
	c.calls++
	return nil, errors.New("unexpected outbound request")
}

func TestDisallowedHostRejectedBeforeAnyNetworkRequest(t *testing.T) {
	transport := &captureTransport{}
	client := NewClient(false)
	client.HTTP = &http.Client{Transport: transport}
	client.AllowedHosts, _ = ParseAPIHosts("api.deepseek.com")
	_, err := client.Forward(context.Background(), validRequest())
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 403 || apiErr.Retryable || transport.calls != 0 {
		t.Fatalf("disallowed host was not blocked before transport: %v calls=%d", err, transport.calls)
	}
}
