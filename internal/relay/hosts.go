package relay

import (
	"errors"
	"net"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"unicode"
)

const DefaultAPIHosts = "integrate.api.nvidia.com,api.deepseek.com,api.openai.com,openrouter.ai"

var ErrHostNotAllowed = errors.New("此 API 地址不在服务器转发白名单中；请使用支持浏览器跨域的接口或联系部署者")

// HostAllowlist matches exact hostnames and ports, never string suffixes. A
// hostname without a port means 443. A nil list is unrestricted for callers
// that explicitly use the relay client without the website policy.
type HostAllowlist struct {
	all   bool
	hosts map[string]bool
}

func ParseAPIHosts(value string) (*HostAllowlist, error) {
	if len(value) > 16384 {
		return nil, errors.New("API_HOSTS is too long")
	}
	list := &HostAllowlist{hosts: make(map[string]bool)}
	if strings.TrimSpace(value) == "*" {
		list.all = true
		return list, nil
	}
	for _, entry := range strings.FieldsFunc(value, func(r rune) bool { return r == ',' || unicode.IsSpace(r) }) {
		u, err := url.Parse("https://" + entry)
		if err != nil || u.Host == "" || u.Path != "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.ContainsAny(entry, "/*?#@%\\") || strings.HasSuffix(entry, ":") {
			return nil, errors.New("API_HOSTS must contain exact hostnames with optional ports, separated by commas; use * alone to allow all hosts")
		}
		authority, err := canonicalAuthority(u)
		if err != nil {
			return nil, errors.New("API_HOSTS contains an invalid hostname or port; international domains must use punycode")
		}
		list.hosts[authority] = true
	}
	return list, nil
}

func canonicalHost(host string) (string, error) {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if ip, err := netip.ParseAddr(host); err == nil {
		if ip.Zone() != "" {
			return "", errors.New("invalid host")
		}
		return ip.Unmap().String(), nil
	}
	if len(host) == 0 || len(host) > 253 {
		return "", errors.New("invalid host")
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", errors.New("invalid host")
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return "", errors.New("invalid host")
			}
		}
	}
	return host, nil
}

func canonicalAuthority(u *url.URL) (string, error) {
	host, err := canonicalHost(u.Hostname())
	if err != nil {
		return "", err
	}
	port := u.Port()
	if port == "" {
		port = "443"
		if u.Scheme == "http" {
			port = "80"
		}
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return "", errors.New("invalid port")
	}
	return net.JoinHostPort(host, strconv.Itoa(n)), nil
}

func (c *Client) Endpoint(base string) (string, error) {
	endpoint, err := Endpoint(base, c.AllowPrivate)
	if err != nil {
		return "", err
	}
	u, _ := url.Parse(endpoint)
	authority, err := canonicalAuthority(u)
	if err != nil {
		return "", errors.New("API 地址无效")
	}
	if c.AllowedHosts != nil && !c.AllowedHosts.all && !c.AllowedHosts.hosts[authority] {
		return "", ErrHostNotAllowed
	}
	// Canonicalize equivalent spellings before transport and host quota lookup.
	u.Host = authority
	return u.String(), nil
}

func UpstreamHost(endpoint string) string {
	u, _ := url.Parse(endpoint)
	return u.Hostname()
}
