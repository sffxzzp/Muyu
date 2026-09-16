package relay

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

func Endpoint(base string, allowPrivate bool) (string, error) {
	u, err := url.Parse(strings.TrimSpace(base))
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || len(base) > 1500 {
		return "", errors.New("请填写不含账号、查询参数或片段的 API Base URL")
	}
	if u.Scheme != "https" && !(allowPrivate && u.Scheme == "http") {
		return "", errors.New("公开服务仅支持 HTTPS 模型接口")
	}
	if !allowPrivate {
		host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
		if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
			return "", errors.New("公开服务不能访问本地或内网模型地址")
		}
		if ip, err := netip.ParseAddr(host); err == nil && !publicIP(ip) {
			return "", errors.New("公开服务不能访问本地或内网模型地址")
		}
	}
	u.Path = strings.TrimRight(u.Path, "/")
	if !strings.HasSuffix(u.Path, "/chat/completions") {
		u.Path += "/chat/completions"
	}
	u.RawPath = ""
	return u.String(), nil
}

var reservedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2001::/32"),
	netip.MustParsePrefix("2001::/23"), netip.MustParsePrefix("3fff::/20"),
	netip.MustParsePrefix("2002::/16"), netip.MustParsePrefix("64:ff9b::/96"),
	netip.MustParsePrefix("64:ff9b:1::/48"), netip.MustParsePrefix("100::/64"),
}

func publicIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
		return false
	}
	if ip.Is6() && (!netip.MustParsePrefix("2000::/3").Contains(ip) || ip.Zone() != "") {
		return false
	}
	for _, prefix := range reservedPrefixes {
		if prefix.Contains(ip) {
			return false
		}
	}
	return true
}

func SafeHTTPClient(allowPrivate bool) *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy: nil, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
		MaxIdleConns: 100, MaxIdleConnsPerHost: 8, MaxConnsPerHost: 32,
		IdleConnTimeout: 90 * time.Second, TLSHandshakeTimeout: 10 * time.Second,
		ResponseHeaderTimeout: 180 * time.Second, ForceAttemptHTTP2: true,
	}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, errors.New("invalid upstream address")
		}
		ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if err != nil || len(ips) == 0 {
			return nil, errors.New("upstream DNS resolution failed")
		}
		// Check every result, then dial the exact checked address. A subsequent DNS
		// change cannot redirect this connection into the private network.
		for _, ip := range ips {
			if !allowPrivate && !publicIP(ip) {
				return nil, errors.New("private upstream address is blocked")
			}
		}
		var lastErr error
		for _, ip := range ips {
			conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if err == nil {
				return conn, nil
			}
			lastErr = err
		}
		return nil, lastErr
	}
	return &http.Client{
		Transport: transport, Timeout: 185 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}
}
