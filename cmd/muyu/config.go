package main

import (
	"fmt"
	"net/netip"
	"strconv"
	"strings"

	"subtitle-studio/internal/relay"
	"subtitle-studio/internal/server"
)

type securityConfig struct {
	Limits         server.Limits
	AllowedHosts   *relay.HostAllowlist
	TrustedProxies []netip.Prefix
}

func readSecurityConfig(getenv func(string) string) (securityConfig, error) {
	config := securityConfig{Limits: server.DefaultLimits()}
	for _, setting := range []struct {
		name string
		dest *int
		max  int
	}{
		{"IP_RPM", &config.Limits.IPRPM, 1000000},
		{"HOST_RPM", &config.Limits.HostRPM, 1000000},
		{"GLOBAL_RPM", &config.Limits.GlobalRPM, 1000000},
		{"IP_CONCURRENCY", &config.Limits.IPConcurrency, 4096},
		{"HOST_CONCURRENCY", &config.Limits.HostConcurrency, 4096},
		{"MAX_CONCURRENT_REQUESTS", &config.Limits.GlobalConcurrency, 4096},
	} {
		value := strings.TrimSpace(getenv(setting.name))
		if value == "" {
			continue
		}
		n, err := strconv.Atoi(value)
		if err != nil || n < 1 || n > setting.max {
			return config, fmt.Errorf("%s must be an integer between 1 and %d", setting.name, setting.max)
		}
		*setting.dest = n
	}
	hosts := strings.TrimSpace(getenv("API_HOSTS"))
	if hosts == "" {
		hosts = relay.DefaultAPIHosts
	}
	var err error
	config.AllowedHosts, err = relay.ParseAPIHosts(hosts)
	if err != nil {
		return config, err
	}
	config.TrustedProxies, err = server.ParseTrustedProxies(getenv("TRUSTED_PROXIES"))
	return config, err
}
