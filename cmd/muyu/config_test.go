package main

import (
	"strings"
	"testing"

	"subtitle-studio/internal/relay"
	"subtitle-studio/internal/server"
)

func TestSecurityConfigDefaultsAndOverrides(t *testing.T) {
	config, err := readSecurityConfig(func(string) string { return "" })
	if err != nil || config.Limits != server.DefaultLimits() || len(config.TrustedProxies) != 0 {
		t.Fatalf("incorrect defaults: %+v %v", config, err)
	}
	client := relay.NewClient(false)
	client.AllowedHosts = config.AllowedHosts
	for _, host := range []string{"integrate.api.nvidia.com", "api.deepseek.com", "api.openai.com", "openrouter.ai"} {
		if _, err := client.Endpoint("https://" + host + "/v1"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := client.Endpoint("https://unconfigured.example/v1"); err == nil {
		t.Fatal("default policy permitted an arbitrary host")
	}
	env := map[string]string{
		"IP_RPM": " 12 ", "HOST_RPM": "60", "GLOBAL_RPM": "100",
		"IP_CONCURRENCY": "3", "HOST_CONCURRENCY": "5", "MAX_CONCURRENT_REQUESTS": "9",
		"API_HOSTS": "api.example.com:8443", "TRUSTED_PROXIES": "127.0.0.1,::1/128",
	}
	config, err = readSecurityConfig(func(key string) string { return env[key] })
	want := server.Limits{IPRPM: 12, HostRPM: 60, GlobalRPM: 100, IPConcurrency: 3, HostConcurrency: 5, GlobalConcurrency: 9}
	if err != nil || config.Limits != want || len(config.TrustedProxies) != 2 {
		t.Fatalf("overrides ignored: %+v %v", config, err)
	}
	client.AllowedHosts = config.AllowedHosts
	if _, err := client.Endpoint("https://api.example.com:8443/v1"); err != nil {
		t.Fatal(err)
	}
	for _, host := range []string{"integrate.api.nvidia.com", "api.deepseek.com", "api.openai.com", "openrouter.ai"} {
		if _, err := client.Endpoint("https://" + host + "/v1"); err == nil {
			t.Fatal("explicit allowlist must replace the defaults")
		}
	}
}

func TestSecurityConfigRejectsInvalidValues(t *testing.T) {
	for _, key := range []string{"IP_RPM", "HOST_RPM", "GLOBAL_RPM", "IP_CONCURRENCY", "HOST_CONCURRENCY", "MAX_CONCURRENT_REQUESTS"} {
		for _, value := range []string{"0", "-1", "1.5", "unlimited", "1000001"} {
			t.Run(key+"/"+value, func(t *testing.T) {
				_, err := readSecurityConfig(func(name string) string {
					if name == key {
						return value
					}
					return ""
				})
				if err == nil || !strings.Contains(err.Error(), key) {
					t.Fatalf("invalid config silently accepted: %v", err)
				}
			})
		}
	}
	for key, value := range map[string]string{"API_HOSTS": "https://api.example.com/v1", "TRUSTED_PROXIES": "proxy.example.com"} {
		_, err := readSecurityConfig(func(name string) string {
			if name == key {
				return value
			}
			return ""
		})
		if err == nil || !strings.Contains(err.Error(), key) {
			t.Fatalf("invalid %s accepted: %v", key, err)
		}
	}
}
