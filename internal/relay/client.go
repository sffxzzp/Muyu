package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

// Only the non-streaming Chat Completions fields used by this application are
// accepted. The server owns transport policy; translation rules live in the browser.
type Payload struct {
	Model               string    `json:"model"`
	Messages            []Message `json:"messages"`
	Stream              bool      `json:"stream"`
	MaxTokens           *int      `json:"max_tokens,omitempty"`
	MaxCompletionTokens *int      `json:"max_completion_tokens,omitempty"`
	Temperature         *float64  `json:"temperature,omitempty"`
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type Request struct {
	BaseURL        string  `json:"baseUrl"`
	APIKey         string  `json:"apiKey"`
	Payload        Payload `json:"payload"`
	TimeoutSeconds int     `json:"timeoutSeconds"`
}

func (r Request) Validate() error {
	if strings.TrimSpace(r.APIKey) == "" || len(r.APIKey) > 4096 || strings.IndexFunc(r.APIKey, func(c rune) bool { return c < 0x20 || c > 0x7e }) >= 0 {
		return errors.New("请填写有效的 API Key")
	}
	p := r.Payload
	if strings.TrimSpace(p.Model) == "" || len(p.Model) > 200 || p.Stream || len(p.Messages) < 1 || len(p.Messages) > 20 {
		return errors.New("请求数据无效或过大")
	}
	size := 0
	for _, message := range p.Messages {
		if (message.Role != "system" && message.Role != "user" && message.Role != "assistant") || strings.TrimSpace(message.Content) == "" {
			return errors.New("请求数据无效或过大")
		}
		size += len(message.Content)
	}
	if size > 512<<10 {
		return errors.New("请求超过大小限制")
	}
	tokens := p.MaxTokens
	if tokens == nil {
		tokens = p.MaxCompletionTokens
	}
	if tokens == nil || (p.MaxTokens != nil && p.MaxCompletionTokens != nil) || *tokens < 256 || *tokens > 32768 || r.TimeoutSeconds < 10 || r.TimeoutSeconds > 180 {
		return errors.New("输出 Token 上限或请求超时设置无效")
	}
	if p.Temperature != nil && (*p.Temperature < 0 || *p.Temperature > 2) {
		return errors.New("Temperature 必须在 0～2 之间")
	}
	return nil
}

type Response struct {
	Status     int
	RetryAfter string
	Body       []byte
}

type APIError struct {
	Message   string
	Retryable bool
	Status    int
}

func (e *APIError) Error() string { return e.Message }

type Client struct {
	HTTP         *http.Client
	AllowPrivate bool
	AllowedHosts *HostAllowlist
}

func NewClient(allowPrivate bool) *Client {
	return &Client{HTTP: SafeHTTPClient(allowPrivate), AllowPrivate: allowPrivate}
}

func (c *Client) Forward(ctx context.Context, req Request) (Response, error) {
	var result Response
	if err := req.Validate(); err != nil {
		return result, &APIError{Message: err.Error(), Status: http.StatusBadRequest}
	}
	endpoint, err := c.Endpoint(req.BaseURL)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, ErrHostNotAllowed) {
			status = http.StatusForbidden
		}
		return result, &APIError{Message: err.Error(), Status: status}
	}
	body, err := json.Marshal(req.Payload)
	if err != nil {
		return result, err
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(req.TimeoutSeconds)*time.Second)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return result, &APIError{Message: "API 地址无效", Status: http.StatusBadRequest}
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+req.APIKey)
	response, err := c.HTTP.Do(httpReq)
	if err != nil {
		message := "无法连接模型接口，请检查地址、网络或稍后重试"
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			message = "模型请求超时，可以增大超时或减小字幕块"
		}
		return result, &APIError{Message: message, Retryable: true, Status: http.StatusBadGateway}
	}
	defer response.Body.Close()
	result.Status, result.RetryAfter = response.StatusCode, response.Header.Get("Retry-After")
	if response.StatusCode != http.StatusOK {
		// Never relay upstream errors, cookies, redirects or arbitrary headers:
		// provider bodies and URLs can contain credentials.
		return result, nil
	}
	result.Body, err = io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	if err != nil || len(result.Body) > 2<<20 {
		return Response{}, &APIError{Message: "模型响应读取失败或超过 2 MB", Retryable: true, Status: http.StatusBadGateway}
	}
	return result, nil
}
