package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"subtitle-studio/internal/relay"
	"subtitle-studio/internal/server"
	"subtitle-studio/web"
)

func main() {
	address := os.Getenv("ADDR")
	if address == "" {
		host := os.Getenv("LISTEN_HOST")
		if host == "" {
			host = "127.0.0.1"
		}
		port := os.Getenv("LISTEN_PORT")
		if port == "" {
			port = "7777"
		}
		address = net.JoinHostPort(host, port)
	}
	security, err := readSecurityConfig(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	uiLanguage := "en"
	switch strings.ToLower(strings.TrimSpace(os.Getenv("UI_LANG"))) {
	case "", "en":
	case "zh-cn":
		uiLanguage = "zh-CN"
	default:
		log.Fatal("UI_LANG must be en or zh-CN")
	}
	client := relay.NewClient(os.Getenv("ALLOW_PRIVATE_UPSTREAMS") == "true")
	client.AllowedHosts = security.AllowedHosts
	app := server.New(client, web.Assets(), security.Limits.GlobalConcurrency)
	app.Limiter = server.NewLimiter(security.Limits)
	app.TrustedProxies = security.TrustedProxies
	app.DefaultUILanguage = uiLanguage
	httpServer := &http.Server{
		Addr: address, Handler: app.Handler(),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second,
		WriteTimeout: 195 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
	}()
	log.Printf("MUYU is listening on %s (tasks are stored in the browser; the server does not store subtitles or API keys)", address)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
