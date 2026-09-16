.DEFAULT_GOAL := build
.PHONY: deps build build-windows frontend test test-e2e dev clean

GO ?= go
NPM ?= npm
WINDOWS_ARCH ?= amd64

deps: web/node_modules/.muyu-dependencies

web/node_modules/.muyu-dependencies: web/package.json web/package-lock.json
	cd web && $(NPM) ci
	touch $@

frontend: deps
	cd web && $(NPM) run build

build: frontend
	mkdir -p bin
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags="-s -w" -o bin/muyu ./cmd/muyu

build-windows: frontend
	mkdir -p bin
	CGO_ENABLED=0 GOOS=windows GOARCH=$(WINDOWS_ARCH) $(GO) build -trimpath -ldflags="-s -w" -o bin/muyu-windows-$(WINDOWS_ARCH).exe ./cmd/muyu

test: frontend
	$(GO) test ./...
	cd web && $(NPM) test

test-e2e: build
	cd web && $(NPM) run test:e2e

dev:
	$(GO) run ./cmd/muyu

clean:
	rm -rf bin web/dist
