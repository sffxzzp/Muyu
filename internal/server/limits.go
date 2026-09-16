package server

import (
	"math"
	"sync"
	"time"
)

// Limits apply to this Go process. RPM is a token refill rate; the initial
// burst is at most ten requests. No rejected request is queued on the server.
type Limits struct {
	IPRPM             int
	HostRPM           int
	GlobalRPM         int
	IPConcurrency     int
	HostConcurrency   int
	GlobalConcurrency int
}

func DefaultLimits() Limits {
	return Limits{IPRPM: 60, HostRPM: 300, GlobalRPM: 600, IPConcurrency: 2, HostConcurrency: 8, GlobalConcurrency: 32}
}

type quota struct {
	tokens float64
	last   time.Time
	seen   time.Time
	active int
}

func burst(rpm int) float64 { return float64(min(rpm, 10)) }

func newQuota(rpm int, now time.Time) *quota {
	return &quota{tokens: burst(rpm), last: now, seen: now}
}

func (q *quota) refill(rpm int, now time.Time) {
	if now.After(q.last) {
		q.tokens = math.Min(burst(rpm), q.tokens+now.Sub(q.last).Seconds()*float64(rpm)/60)
		q.last = now
	}
	q.seen = now
}

func (q *quota) retryAfter(rpm, concurrency int) int {
	wait := 0
	if q.tokens < 1 {
		wait = max(1, int(math.Ceil((1-q.tokens)*60/float64(rpm))))
	}
	if q.active >= concurrency {
		wait = max(wait, 2)
	}
	return wait
}

// Limiter bounds both request volume and live work. Maps retain recently used
// identities so reconnecting cannot reset a quota; full maps fail closed.
type Limiter struct {
	mu          sync.Mutex
	limits      Limits
	global      *quota
	ips         map[string]*quota
	hosts       map[string]*quota
	now         func() time.Time
	nextCleanup time.Time
	maxIPs      int
	maxHosts    int
}

func NewLimiter(limits Limits) *Limiter {
	return &Limiter{limits: limits, ips: make(map[string]*quota), hosts: make(map[string]*quota), now: time.Now, maxIPs: 10000, maxHosts: 1000}
}

func (l *Limiter) cleanup(now time.Time) {
	if now.Before(l.nextCleanup) {
		return
	}
	l.nextCleanup = now.Add(time.Minute)
	for _, entries := range []map[string]*quota{l.ips, l.hosts} {
		for key, q := range entries {
			if q.active == 0 && now.Sub(q.seen) >= 10*time.Minute {
				delete(entries, key)
			}
		}
	}
}

// acquireRequest runs before reading a POST body. Both quotas are checked
// atomically, and a rejected request does not consume the other quota.
func (l *Limiter) acquireRequest(ip string) (release func(), retryAfter int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.cleanup(now)
	if l.global == nil {
		l.global = newQuota(l.limits.GlobalRPM, now)
	}
	l.global.refill(l.limits.GlobalRPM, now)
	globalWait := l.global.retryAfter(l.limits.GlobalRPM, l.limits.GlobalConcurrency)
	q := l.ips[ip]
	if q == nil {
		if globalWait > 0 {
			return nil, globalWait
		}
		if len(l.ips) >= l.maxIPs {
			return nil, 60
		}
		q = newQuota(l.limits.IPRPM, now)
		l.ips[ip] = q
	}
	q.refill(l.limits.IPRPM, now)
	if wait := max(globalWait, q.retryAfter(l.limits.IPRPM, l.limits.IPConcurrency)); wait > 0 {
		return nil, wait
	}
	l.global.tokens--
	l.global.active++
	q.tokens--
	q.active++
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			l.global.active--
			q.active--
		})
	}, 0
}

// The host key excludes paths, ports and API keys. Changing any of those must
// not create a fresh allowance for the same upstream host.
func (l *Limiter) acquireHost(host string) (release func(), retryAfter int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.cleanup(now)
	q := l.hosts[host]
	if q == nil {
		if len(l.hosts) >= l.maxHosts {
			return nil, 60
		}
		q = newQuota(l.limits.HostRPM, now)
		l.hosts[host] = q
	}
	q.refill(l.limits.HostRPM, now)
	if wait := q.retryAfter(l.limits.HostRPM, l.limits.HostConcurrency); wait > 0 {
		return nil, wait
	}
	q.tokens--
	q.active++
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			q.active--
		})
	}, 0
}
