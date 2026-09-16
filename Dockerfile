FROM --platform=$BUILDPLATFORM node:22-alpine AS frontend
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS backend
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY go.mod ./
COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY web/embed.go ./web/embed.go
COPY --from=frontend /src/web/dist ./web/dist
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -o /muyu ./cmd/muyu

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=backend /muyu /muyu
COPY THIRD_PARTY_NOTICES.txt /THIRD_PARTY_NOTICES.txt
# Container port forwarding needs a listener on the container network interface.
ENV LISTEN_HOST=0.0.0.0 LISTEN_PORT=7777
EXPOSE 7777
ENTRYPOINT ["/muyu"]
