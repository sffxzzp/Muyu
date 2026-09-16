package server

import (
	"errors"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"unicode"
)

func ParseTrustedProxies(value string) ([]netip.Prefix, error) {
	var prefixes []netip.Prefix
	for _, entry := range strings.FieldsFunc(value, func(r rune) bool { return r == ',' || unicode.IsSpace(r) }) {
		prefix, err := netip.ParsePrefix(entry)
		if err != nil {
			ip, ipErr := netip.ParseAddr(entry)
			if ipErr != nil || ip.Zone() != "" {
				return nil, errors.New("TRUSTED_PROXIES must contain IP addresses or CIDR ranges")
			}
			ip = ip.Unmap()
			prefix = netip.PrefixFrom(ip, ip.BitLen())
		} else if prefix.Addr().Is4In6() {
			if prefix.Bits() < 96 {
				return nil, errors.New("TRUSTED_PROXIES contains an invalid mapped IPv4 range")
			}
			prefix = netip.PrefixFrom(prefix.Addr().Unmap(), prefix.Bits()-96)
		}
		prefixes = append(prefixes, prefix.Masked())
	}
	return prefixes, nil
}

func (s *Server) trustedProxy(ip netip.Addr) bool {
	for _, prefix := range s.TrustedProxies {
		if prefix.Contains(ip) {
			return true
		}
	}
	return false
}

func (s *Server) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil || peer.Zone() != "" {
		return "unknown"
	}
	peer = peer.Unmap()
	client := peer
	// Only a configured immediate peer can vouch for X-Forwarded-For. Walk
	// right-to-left and stop at the first untrusted hop, ignoring forged prefixes.
	if s.trustedProxy(peer) {
		forwarded := strings.Join(r.Header.Values("X-Forwarded-For"), ",")
		parts := strings.Split(forwarded, ",")
		if forwarded != "" && len(forwarded) <= 2048 && len(parts) <= 32 {
			valid := true
			chain := make([]netip.Addr, len(parts))
			for i, part := range parts {
				ip, err := netip.ParseAddr(strings.TrimSpace(part))
				if err != nil || ip.Zone() != "" {
					valid = false
					break
				}
				chain[i] = ip.Unmap()
			}
			if valid {
				for i := len(chain) - 1; i >= 0 && s.trustedProxy(client); i-- {
					client = chain[i]
				}
			}
		}
	}
	if client.Is6() {
		// Rotating interface identifiers within the same IPv6 subnet must not
		// bypass a quota or grow the identity map indefinitely.
		return netip.PrefixFrom(client, 64).Masked().String()
	}
	return client.String()
}
