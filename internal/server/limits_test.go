package server

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func clockedLimiter(limits Limits) (*Limiter, *time.Time) {
	now := time.Unix(10000, 0)
	l := NewLimiter(limits)
	l.now = func() time.Time { return now }
	return l, &now
}

func admit(t *testing.T, l *Limiter, ip string) func() {
	t.Helper()
	release, wait := l.acquireRequest(ip)
	if wait != 0 || release == nil {
		t.Fatalf("%s unexpectedly throttled for %d seconds", ip, wait)
	}
	return release
}

func TestIPRateRefillAndIndependentVisitors(t *testing.T) {
	limits := DefaultLimits()
	limits.IPRPM = 2
	l, now := clockedLimiter(limits)
	admit(t, l, "a")()
	admit(t, l, "a")()
	if release, wait := l.acquireRequest("a"); release != nil || wait != 30 {
		t.Fatalf("IP limit not enforced: wait=%d", wait)
	}
	admit(t, l, "b")()
	*now = now.Add(29 * time.Second)
	if _, wait := l.acquireRequest("a"); wait != 1 {
		t.Fatalf("incorrect remaining delay: %d", wait)
	}
	*now = now.Add(time.Second)
	admit(t, l, "a")()
	if _, wait := l.acquireRequest("a"); wait != 30 {
		t.Fatalf("refill produced extra allowance: %d", wait)
	}
}

func TestGlobalRateCannotBeBypassedByChangingClients(t *testing.T) {
	limits := DefaultLimits()
	limits.GlobalRPM = 2
	l, now := clockedLimiter(limits)
	admit(t, l, "a")()
	admit(t, l, "b")()
	if _, wait := l.acquireRequest("c"); wait != 30 {
		t.Fatalf("global rate limit missing: %d", wait)
	}
	if _, exists := l.ips["c"]; exists {
		t.Fatal("global rejection should not allocate a new identity")
	}
	*now = now.Add(30 * time.Second)
	admit(t, l, "c")()
}

func TestRejectedIPDoesNotDrainOtherVisitorsQuota(t *testing.T) {
	limits := DefaultLimits()
	limits.IPRPM, limits.GlobalRPM = 1, 2
	l, _ := clockedLimiter(limits)
	admit(t, l, "a")()
	for i := 0; i < 50; i++ {
		if _, wait := l.acquireRequest("a"); wait != 60 {
			t.Fatalf("incorrect IP cooldown: %d", wait)
		}
	}
	admit(t, l, "b")()
}

func TestIPAndGlobalConcurrencyRelease(t *testing.T) {
	limits := DefaultLimits()
	limits.IPConcurrency, limits.GlobalConcurrency = 1, 2
	l, _ := clockedLimiter(limits)
	a := admit(t, l, "a")
	if _, wait := l.acquireRequest("a"); wait != 2 {
		t.Fatal("per-IP concurrency limit missing")
	}
	b := admit(t, l, "b")
	if _, wait := l.acquireRequest("c"); wait != 2 {
		t.Fatal("global concurrency limit missing")
	}
	a()
	a() // A cleanup function must never release someone else's slot.
	c := admit(t, l, "c")
	if _, wait := l.acquireRequest("d"); wait != 2 {
		t.Fatal("duplicate release opened an extra slot")
	}
	b()
	c()
	if l.global.active != 0 || l.ips["a"].active != 0 {
		t.Fatal("active counts leaked")
	}
}

func TestHostRateAndConcurrencyAreIndependent(t *testing.T) {
	limits := DefaultLimits()
	limits.HostRPM, limits.HostConcurrency = 1, 1
	l, now := clockedLimiter(limits)
	a, wait := l.acquireHost("api.example.com")
	if wait != 0 {
		t.Fatal(wait)
	}
	if _, wait := l.acquireHost("api.example.com"); wait != 60 {
		t.Fatalf("host rate not enforced: %d", wait)
	}
	b, wait := l.acquireHost("other.example.com")
	if wait != 0 {
		t.Fatal("unrelated host shared quota")
	}
	b()
	*now = now.Add(time.Minute)
	if _, wait := l.acquireHost("api.example.com"); wait != 2 {
		t.Fatalf("live request lost its concurrency slot: %d", wait)
	}
	a()
	c, wait := l.acquireHost("api.example.com")
	if wait != 0 {
		t.Fatal("rejected request consumed a token")
	}
	c()
	c()
	if l.hosts["api.example.com"].active != 0 {
		t.Fatal("host active counts leaked")
	}
}

func TestQuotaMapsAreBoundedAndNeverEvictLiveRequests(t *testing.T) {
	l, now := clockedLimiter(DefaultLimits())
	l.maxIPs, l.maxHosts = 1, 1
	a := admit(t, l, "a")
	h, _ := l.acquireHost("host-a")
	*now = now.Add(11 * time.Minute)
	if _, wait := l.acquireRequest("b"); wait != 60 || len(l.ips) != 1 {
		t.Fatal("IP map evicted a live quota or grew past its bound")
	}
	if _, wait := l.acquireHost("host-b"); wait != 60 || len(l.hosts) != 1 {
		t.Fatal("host map evicted a live quota or grew past its bound")
	}
	a()
	h()
	*now = now.Add(time.Minute)
	admit(t, l, "b")()
	h2, wait := l.acquireHost("host-b")
	if wait != 0 {
		t.Fatal("expired idle host quota not removed")
	}
	h2()
	if _, exists := l.ips["a"]; exists {
		t.Fatal("expired idle IP quota not removed")
	}
}

func TestParallelAdmissionNeverExceedsConcurrency(t *testing.T) {
	limits := DefaultLimits()
	limits.GlobalConcurrency = 3
	l := NewLimiter(limits)
	start, finish := make(chan struct{}), make(chan struct{})
	var checked, done sync.WaitGroup
	var admitted atomic.Int32
	for i := 0; i < 64; i++ {
		checked.Add(1)
		done.Add(1)
		go func(i int) {
			defer done.Done()
			<-start
			release, wait := l.acquireRequest(fmt.Sprint(i))
			if wait == 0 {
				admitted.Add(1)
			}
			checked.Done()
			<-finish
			if release != nil {
				release()
			}
		}(i)
	}
	close(start)
	checked.Wait()
	if admitted.Load() != 3 {
		t.Errorf("admitted %d requests, want 3", admitted.Load())
	}
	close(finish)
	done.Wait()
	admit(t, l, "after-release")()
}
