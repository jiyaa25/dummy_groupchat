// Dynamic Performance-Based Load Balancer
// =========================================
// SYS1: 172.17.0.62:3000 (HTTP, no TLS at LB level)
// Backend SYS2: https://172.17.0.63:3000
// Backend SYS3: https://172.17.0.64:3000
// Backend SYS4: https://172.17.0.65:3000
//
// Routing Algorithm:
//   score = 0.40*norm(queue) + 0.20*norm(cpu) + 0.10*norm(memory)
//         + 0.15*norm(active) + 0.15*norm(avgResponseTime)
//   Lower score = better backend.
//
// Overload/Recovery thresholds prevent routing thrash.
// Heartbeat reception at POST /lb/heartbeat.
// Active health polling every 2s as fallback.
// Idempotent POST /message retries via stable message_id.
// WebSocket (Socket.IO) proxied via TCP hijack.

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ─── Helpers ──────────────────────────────────────────────────────────────────

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return def
}

func envFloat(key string, def float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}

func generateUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%12x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// ─── Configuration ────────────────────────────────────────────────────────────

type Config struct {
	Port              int
	Backends          []string
	TLSEnabled        bool
	CertFile          string
	KeyFile           string
	HeartbeatTimeout  time.Duration
	OverloadThreshold float64 // 0–100 score; above this = overloaded
	RecoveryThreshold float64 // 0–100 score; below this = recovered
	RetryMax          int
	// Score weights
	WQueue    float64
	WCPU      float64
	WMemory   float64
	WActive   float64
	WRespTime float64
}

func loadConfig() Config {
	cfg := Config{
		Port:              envInt("LB_PORT", 3000),
		Backends:          strings.Split(envStr("BACKENDS", "https://172.17.0.63:3000,https://172.17.0.64:3000,https://172.17.0.65:3000"), ","),
		TLSEnabled:        false,
		CertFile:          envStr("TLS_CERT", "cert.pem"),
		KeyFile:           envStr("TLS_KEY", "key.pem"),
		HeartbeatTimeout:  envDuration("HEARTBEAT_TIMEOUT", 3*time.Second),
		OverloadThreshold: envFloat("OVERLOAD_THRESHOLD", 70.0),
		RecoveryThreshold: envFloat("RECOVERY_THRESHOLD", 55.0),
		RetryMax:          envInt("RETRY_MAX", 2),
		WQueue:            envFloat("W_QUEUE", 0.40),
		WCPU:              envFloat("W_CPU", 0.20),
		WMemory:           envFloat("W_MEMORY", 0.10),
		WActive:           envFloat("W_ACTIVE", 0.15),
		WRespTime:         envFloat("W_RESPTIME", 0.15),
	}
	return cfg
}

// ─── Backend State ────────────────────────────────────────────────────────────

// HeartbeatPayload is the JSON structure sent by each backend
type HeartbeatPayload struct {
	Backend         string  `json:"backend"`
	Timestamp       int64   `json:"timestamp"`
	Status          string  `json:"status"`
	QueueLength     float64 `json:"queueLength"`
	CPU             float64 `json:"cpu"`
	Memory          float64 `json:"memory"`
	ActiveRequests  float64 `json:"activeRequests"`
	AvgResponseTime float64 `json:"avgResponseTime"`
}

type BackendState struct {
	mu sync.RWMutex

	Name  string   // e.g. "172.17.0.63:3000"
	URL   *url.URL
	Proxy *httputil.ReverseProxy

	// Health
	Healthy       bool
	LastHeartbeat time.Time

	// Heartbeat metrics
	QueueLength     float64
	CPU             float64
	Memory          float64
	ActiveRequests  float64
	AvgResponseTime float64

	// Computed score (0–100, lower = better)
	Score float64

	// LB-side live request counter (not from heartbeat)
	liveReqs atomic.Int64

	// Passive failure counter
	consecutiveFails atomic.Int32
}

func (b *BackendState) incLive() { b.liveReqs.Add(1) }
func (b *BackendState) decLive() {
	if v := b.liveReqs.Add(-1); v < 0 {
		b.liveReqs.Store(0)
	}
}

// isHealthy returns true if backend is marked healthy AND heartbeat is recent
func (b *BackendState) isHealthy(timeout time.Duration) bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.Healthy && time.Since(b.LastHeartbeat) < timeout
}

// effectiveMetrics returns metrics adjusted with LB-tracked live requests
func (b *BackendState) effectiveMetrics() (queue, cpu, mem, active, rt float64) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	live := float64(b.liveReqs.Load())
	return b.QueueLength + live,
		b.CPU,
		b.Memory,
		b.ActiveRequests + live,
		b.AvgResponseTime
}

func (b *BackendState) applyHeartbeat(hb HeartbeatPayload) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.Healthy         = (hb.Status == "healthy" || hb.Status == "ok")
	b.LastHeartbeat   = time.Now()
	b.QueueLength     = hb.QueueLength
	b.CPU             = hb.CPU
	b.Memory          = hb.Memory
	b.ActiveRequests  = hb.ActiveRequests
	b.AvgResponseTime = hb.AvgResponseTime
	b.consecutiveFails.Store(0)
}

func (b *BackendState) markUnhealthy(reason string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.Healthy {
		log.Printf("[LB] %s → UNHEALTHY (%s)", b.Name, reason)
	}
	b.Healthy = false
}

func (b *BackendState) markHealthy() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.Healthy {
		log.Printf("[LB] %s → HEALTHY (restored)", b.Name)
	}
	b.Healthy      = true
	b.LastHeartbeat = time.Now()
	b.consecutiveFails.Store(0)
}

// ─── TLS Transport (reused) ───────────────────────────────────────────────────

func insecureTLSTransport() *http.Transport {
	return &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:        200,
		MaxIdleConnsPerHost: 50,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 5 * time.Second,
	}
}

// ─── Load Balancer ────────────────────────────────────────────────────────────

type LB struct {
	cfg      Config
	mu       sync.RWMutex
	backends []*BackendState

	totalReqs   atomic.Uint64
	totalErrors atomic.Uint64

	latMu     sync.Mutex
	latencies []float64 // rolling window of response times (ms)
}

func newLB(cfg Config) *LB {
	lb := &LB{cfg: cfg}
	transport := insecureTLSTransport()

	for _, rawURL := range cfg.Backends {
		rawURL = strings.TrimSpace(rawURL)
		if rawURL == "" {
			continue
		}
		u, err := url.Parse(rawURL)
		if err != nil {
			log.Fatalf("[LB] Invalid backend URL %q: %v", rawURL, err)
		}

		proxy := httputil.NewSingleHostReverseProxy(u)
		proxy.Transport = transport
		proxy.FlushInterval = -1 // immediate flush (good for streaming/SSE)

		// Fix Host header for HTTPS backends
		proxy.Director = func(req *http.Request) {
			req.URL.Scheme = u.Scheme
			req.URL.Host   = u.Host
			req.Host        = u.Host
			req.Header.Set("X-Forwarded-Proto", "https")
			if req.Header.Get("X-Real-IP") == "" {
				req.Header.Set("X-Real-IP", req.RemoteAddr)
			}
		}

		// Passive failure detection via proxy error handler
		bs := &BackendState{
			Name:          u.Host,
			URL:           u,
			Proxy:         proxy,
			Healthy:       true,
			LastHeartbeat: time.Now(),
		}

		proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
			bs.consecutiveFails.Add(1)
			if bs.consecutiveFails.Load() >= 3 {
				bs.markUnhealthy("consecutive proxy errors")
			}
			log.Printf("[LB] Proxy error to %s: %v", bs.Name, err)
			http.Error(w, `{"error":"Bad Gateway","code":502}`, http.StatusBadGateway)
		}

		lb.backends = append(lb.backends, bs)
		log.Printf("[LB] Registered backend: %s", u.String())
	}
	return lb
}

// healthyBackends returns all backends that pass health check (read-locked)
func (lb *LB) healthyBackends() []*BackendState {
	lb.mu.RLock()
	defer lb.mu.RUnlock()
	var out []*BackendState
	for _, b := range lb.backends {
		if b.isHealthy(lb.cfg.HeartbeatTimeout) {
			out = append(out, b)
		}
	}
	return out
}

// computeScores calculates and writes normalized scores for all backends
func (lb *LB) computeScores(backends []*BackendState) {
	if len(backends) == 0 {
		return
	}

	type raw struct{ q, c, m, a, r float64 }
	vals := make([]raw, len(backends))
	maxQ, maxC, maxM, maxA, maxR := 1e-9, 1e-9, 1e-9, 1e-9, 1e-9

	for i, b := range backends {
		q, c, m, a, r := b.effectiveMetrics()
		vals[i] = raw{q, c, m, a, r}
		if q > maxQ { maxQ = q }
		if c > maxC { maxC = c }
		if m > maxM { maxM = m }
		if a > maxA { maxA = a }
		if r > maxR { maxR = r }
	}

	for i, b := range backends {
		v := vals[i]
		score := lb.cfg.WQueue*(v.q/maxQ) +
			lb.cfg.WCPU*(v.c/maxC) +
			lb.cfg.WMemory*(v.m/maxM) +
			lb.cfg.WActive*(v.a/maxA) +
			lb.cfg.WRespTime*(v.r/maxR)
		b.mu.Lock()
		b.Score = math.Round(score*1000) / 10 // 0–100 with 1 decimal
		b.mu.Unlock()
	}
}

// selectBackend picks the best healthy backend using performance scoring
func (lb *LB) selectBackend() (*BackendState, string) {
	healthy := lb.healthyBackends()
	if len(healthy) == 0 {
		return nil, "no healthy backends"
	}

	lb.computeScores(healthy)

	// Sort by score ascending
	sort.Slice(healthy, func(i, j int) bool {
		healthy[i].mu.RLock()
		si := healthy[i].Score
		healthy[i].mu.RUnlock()
		healthy[j].mu.RLock()
		sj := healthy[j].Score
		healthy[j].mu.RUnlock()
		return si < sj
	})

	best := healthy[0]
	best.mu.RLock()
	bestScore := best.Score
	best.mu.RUnlock()

	if bestScore <= lb.cfg.OverloadThreshold {
		return best, fmt.Sprintf("best score=%.1f (≤ overload=%.0f)", bestScore, lb.cfg.OverloadThreshold)
	}

	// All backends are overloaded — check if any are in recovery zone
	for _, b := range healthy {
		b.mu.RLock()
		s := b.Score
		b.mu.RUnlock()
		if s <= lb.cfg.RecoveryThreshold {
			return b, fmt.Sprintf("recovery backend score=%.1f (≤ recovery=%.0f)", s, lb.cfg.RecoveryThreshold)
		}
	}

	// All overloaded: use least-overloaded
	return best, fmt.Sprintf("all overloaded, least-loaded score=%.1f", bestScore)
}

// recordLatency adds a response time (ms) to rolling window
func (lb *LB) recordLatency(ms float64) {
	lb.latMu.Lock()
	lb.latencies = append(lb.latencies, ms)
	if len(lb.latencies) > 10000 {
		lb.latencies = lb.latencies[len(lb.latencies)-10000:]
	}
	lb.latMu.Unlock()
}

// ─── Response Recorder (for retry logic) ─────────────────────────────────────

type respRecorder struct {
	header     http.Header
	body       bytes.Buffer
	statusCode int
	written    bool
}

func newRespRecorder() *respRecorder {
	return &respRecorder{header: make(http.Header), statusCode: 200}
}

func (r *respRecorder) Header() http.Header {
	return r.header
}
func (r *respRecorder) WriteHeader(code int) {
	r.statusCode = code
	r.written = true
}
func (r *respRecorder) Write(b []byte) (int, error) {
	if !r.written {
		r.statusCode = 200
	}
	return r.body.Write(b)
}
func (r *respRecorder) flush(w http.ResponseWriter) {
	for k, vv := range r.header {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(r.statusCode)
	w.Write(r.body.Bytes())
}

// ─── Proxy Handler ────────────────────────────────────────────────────────────

func (lb *LB) proxyRequest(w http.ResponseWriter, r *http.Request) {
	lb.totalReqs.Add(1)
	start := time.Now()

	isPostMessage := r.Method == http.MethodPost && r.URL.Path == "/message"

	// For POST /message: buffer body and inject stable message_id for idempotent retries
	var bodyBuf []byte
	var msgID string

	if isPostMessage && lb.cfg.RetryMax > 0 {
		var err error
		bodyBuf, err = io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1MB limit
		if err != nil {
			http.Error(w, "Bad Request", http.StatusBadRequest)
			return
		}
		r.Body.Close()

		// Parse to find/inject message_id
		var bodyMap map[string]interface{}
		contentType := r.Header.Get("Content-Type")

		if strings.Contains(contentType, "application/json") && json.Unmarshal(bodyBuf, &bodyMap) == nil {
			// JSON body
			for _, k := range []string{"message_id", "messageId"} {
				if v, ok := bodyMap[k]; ok {
					msgID = fmt.Sprintf("%v", v)
					break
				}
			}
			if msgID == "" {
				msgID = generateUUID()
				bodyMap["message_id"] = msgID
				bodyBuf, _ = json.Marshal(bodyMap)
			}
		} else {
			// Form-encoded — just generate a UUID; let backend handle the rest
			msgID = generateUUID()
			// Append message_id to body if it's form-encoded
			if len(bodyBuf) > 0 {
				bodyBuf = append(bodyBuf, []byte("&message_id="+msgID)...)
			} else {
				bodyBuf = []byte("message_id=" + msgID)
			}
		}
	}

	maxAttempts := 1
	if isPostMessage && lb.cfg.RetryMax > 0 {
		maxAttempts = lb.cfg.RetryMax + 1
	}

	attempted := make(map[string]bool)
	var lastStatus int

	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(50*(attempt)) * time.Millisecond)
		}

		backend, reason := lb.selectBackend()
		if backend == nil {
			lb.totalErrors.Add(1)
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, `{"error":"Service Unavailable","code":503}`, http.StatusServiceUnavailable)
			log.Printf("[LB] 503 — %s", reason)
			return
		}

		// On retry, try a different backend if possible
		if attempt > 0 && attempted[backend.Name] {
			for _, b := range lb.healthyBackends() {
				if !attempted[b.Name] {
					backend = b
					break
				}
			}
		}
		attempted[backend.Name] = true

		// Restore buffered body for each attempt
		if len(bodyBuf) > 0 {
			r.Body          = io.NopCloser(bytes.NewReader(bodyBuf))
			r.ContentLength = int64(len(bodyBuf))
		}

		backend.incLive()

		if attempt < maxAttempts-1 {
			// Use response recorder to detect failures
			rec := newRespRecorder()
			backend.Proxy.ServeHTTP(rec, r)
			backend.decLive()

			lastStatus = rec.statusCode
			if rec.statusCode < 500 {
				ms := float64(time.Since(start).Milliseconds())
				lb.recordLatency(ms)
				log.Printf("[LB] %s %s → %s (attempt %d) score=%.1f | %s | %d %.0fms",
					r.Method, r.URL.Path, backend.Name, attempt+1, backend.Score, reason, rec.statusCode, ms)
				rec.flush(w)
				return
			}

			// 5xx — penalize and retry
			n := backend.consecutiveFails.Add(1)
			if n >= 3 {
				backend.markUnhealthy("3 consecutive 5xx responses")
			}
			log.Printf("[LB] %s %s → %s returned %d, retrying (attempt %d/%d)",
				r.Method, r.URL.Path, backend.Name, rec.statusCode, attempt+1, maxAttempts)
			continue
		}

		// Final attempt — proxy directly
		log.Printf("[LB] %s %s → %s score=%.1f | %s",
			r.Method, r.URL.Path, backend.Name, backend.Score, reason)
		backend.Proxy.ServeHTTP(w, r)
		backend.decLive()
		ms := float64(time.Since(start).Milliseconds())
		lb.recordLatency(ms)
		return
	}

	lb.totalErrors.Add(1)
	log.Printf("[LB] All %d attempts failed (last status %d) for %s %s",
		maxAttempts, lastStatus, r.Method, r.URL.Path)
	w.Header().Set("Content-Type", "application/json")
	http.Error(w, `{"error":"Service Unavailable after retries","code":503}`, http.StatusServiceUnavailable)
}

// ─── WebSocket Proxy (Socket.IO) ──────────────────────────────────────────────

func (lb *LB) proxyWebSocket(w http.ResponseWriter, r *http.Request) {
	backend, reason := lb.selectBackend()
	if backend == nil {
		http.Error(w, "Service Unavailable", http.StatusServiceUnavailable)
		log.Printf("[LB] WS — no healthy backend: %s", reason)
		return
	}

	log.Printf("[LB] WS %s → %s | score=%.1f", r.URL.Path, backend.Name, backend.Score)
	backend.incLive()
	defer backend.decLive()

	// Dial backend
	var backConn net.Conn
	var err error
	if backend.URL.Scheme == "https" {
		tlsCfg := &tls.Config{
			InsecureSkipVerify: true,
			ServerName:         backend.URL.Hostname(),
		}
		backConn, err = tls.Dial("tcp", backend.URL.Host, tlsCfg)
	} else {
		backConn, err = net.Dial("tcp", backend.URL.Host)
	}
	if err != nil {
		http.Error(w, "Bad Gateway", http.StatusBadGateway)
		log.Printf("[LB] WS dial %s failed: %v", backend.URL.Host, err)
		return
	}
	defer backConn.Close()

	// Hijack client connection
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "Hijack not supported", http.StatusInternalServerError)
		return
	}
	clientConn, _, hijackErr := hijacker.Hijack()
	if hijackErr != nil {
		log.Printf("[LB] WS hijack error: %v", hijackErr)
		return
	}
	defer clientConn.Close()

	// Forward the upgrade request to backend
	r.Header.Set("X-Forwarded-For", r.RemoteAddr)
	r.Header.Set("X-Forwarded-Proto", "https")
	if err := r.Write(backConn); err != nil {
		log.Printf("[LB] WS forward request error: %v", err)
		return
	}

	// Bidirectional pipe
	done := make(chan struct{}, 2)
	go func() { io.Copy(backConn, clientConn); done <- struct{}{} }()
	go func() { io.Copy(clientConn, backConn); done <- struct{}{} }()
	<-done
}

// ─── Heartbeat Handler ────────────────────────────────────────────────────────

func (lb *LB) handleHeartbeat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	var hb HeartbeatPayload
	if err := json.NewDecoder(r.Body).Decode(&hb); err != nil {
		http.Error(w, "Bad Request: "+err.Error(), http.StatusBadRequest)
		return
	}

	lb.mu.RLock()
	var matched *BackendState
	for _, b := range lb.backends {
		if b.Name == hb.Backend ||
			b.URL.Hostname() == hb.Backend ||
			strings.HasPrefix(hb.Backend, b.URL.Hostname()) {
			matched = b
			break
		}
	}
	lb.mu.RUnlock()

	if matched != nil {
		matched.applyHeartbeat(hb)
		log.Printf("[LB] ♥  %s | q=%.0f cpu=%.1f%% mem=%.1f%% active=%.0f rt=%.0fms",
			hb.Backend, hb.QueueLength, hb.CPU, hb.Memory, hb.ActiveRequests, hb.AvgResponseTime)
	} else {
		log.Printf("[LB] Heartbeat from unknown backend: %q (known: %v)", hb.Backend, lb.backendNames())
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"ok":true}`))
}

func (lb *LB) backendNames() []string {
	lb.mu.RLock()
	defer lb.mu.RUnlock()
	names := make([]string, len(lb.backends))
	for i, b := range lb.backends {
		names[i] = b.Name
	}
	return names
}

// ─── LB Metrics Handler ───────────────────────────────────────────────────────

func (lb *LB) handleLBMetrics(w http.ResponseWriter, r *http.Request) {
	lb.mu.RLock()
	type backendInfo struct {
		Name            string  `json:"name"`
		URL             string  `json:"url"`
		Healthy         bool    `json:"healthy"`
		HeartbeatAgeMs  int64   `json:"heartbeatAgeMs"`
		QueueLength     float64 `json:"queueLength"`
		CPU             float64 `json:"cpu"`
		Memory          float64 `json:"memory"`
		ActiveRequests  float64 `json:"activeRequests"`
		AvgResponseTime float64 `json:"avgResponseTime"`
		Score           float64 `json:"score"`
		LiveRequests    int64   `json:"liveRequests"`
		ConsecFails     int32   `json:"consecutiveFails"`
	}

	var infos []backendInfo
	for _, b := range lb.backends {
		b.mu.RLock()
		bi := backendInfo{
			Name:            b.Name,
			URL:             b.URL.String(),
			Healthy:         b.isHealthy(lb.cfg.HeartbeatTimeout),
			HeartbeatAgeMs:  time.Since(b.LastHeartbeat).Milliseconds(),
			QueueLength:     b.QueueLength,
			CPU:             b.CPU,
			Memory:          b.Memory,
			ActiveRequests:  b.ActiveRequests,
			AvgResponseTime: b.AvgResponseTime,
			Score:           b.Score,
			LiveRequests:    b.liveReqs.Load(),
			ConsecFails:     b.consecutiveFails.Load(),
		}
		b.mu.RUnlock()
		infos = append(infos, bi)
	}
	lb.mu.RUnlock()

	// Compute latency stats
	lb.latMu.Lock()
	lats := append([]float64(nil), lb.latencies...)
	lb.latMu.Unlock()

	sort.Float64s(lats)
	var p50, p95, p99, avgLat float64
	if n := len(lats); n > 0 {
		p50 = lats[clamp(int(float64(n)*0.50), 0, n-1)]
		p95 = lats[clamp(int(float64(n)*0.95), 0, n-1)]
		p99 = lats[clamp(int(float64(n)*0.99), 0, n-1)]
		sum := 0.0
		for _, v := range lats {
			sum += v
		}
		avgLat = sum / float64(n)
	}

	resp := map[string]interface{}{
		"backends":      infos,
		"totalRequests": lb.totalReqs.Load(),
		"totalErrors":   lb.totalErrors.Load(),
		"latency": map[string]float64{
			"avgMs": round1(avgLat),
			"p50Ms": round1(p50),
			"p95Ms": round1(p95),
			"p99Ms": round1(p99),
		},
		"config": map[string]interface{}{
			"overloadThreshold":  lb.cfg.OverloadThreshold,
			"recoveryThreshold":  lb.cfg.RecoveryThreshold,
			"heartbeatTimeoutMs": lb.cfg.HeartbeatTimeout.Milliseconds(),
			"retryMax":           lb.cfg.RetryMax,
			"weights": map[string]float64{
				"queue":        lb.cfg.WQueue,
				"cpu":          lb.cfg.WCPU,
				"memory":       lb.cfg.WMemory,
				"activeReqs":   lb.cfg.WActive,
				"responseTime": lb.cfg.WRespTime,
			},
		},
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// handleHealth returns overall LB status
func (lb *LB) handleHealth(w http.ResponseWriter, r *http.Request) {
	healthy := lb.healthyBackends()
	status := "ok"
	code := http.StatusOK
	if len(healthy) == 0 {
		status = "unavailable"
		code = http.StatusServiceUnavailable
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":          status,
		"healthyBackends": len(healthy),
		"totalBackends":   len(lb.backends),
	})
}

// ─── Active Health Poller ─────────────────────────────────────────────────────

func (lb *LB) startHealthPoller() {
	client := &http.Client{
		Timeout:   2 * time.Second,
		Transport: insecureTLSTransport(),
	}

	go func() {
		for {
			time.Sleep(2 * time.Second)

			lb.mu.RLock()
			backends := make([]*BackendState, len(lb.backends))
			copy(backends, lb.backends)
			lb.mu.RUnlock()

			for _, b := range backends {
				go func(b *BackendState) {
					resp, err := client.Get(b.URL.String() + "/health")
					if resp != nil {
						resp.Body.Close()
					}

					if err != nil || resp == nil || resp.StatusCode != http.StatusOK {
						// Only declare unhealthy if heartbeat is also stale
						age := time.Since(b.LastHeartbeat)
						if age > lb.cfg.HeartbeatTimeout {
							b.markUnhealthy(fmt.Sprintf("health poll failed + heartbeat stale %v", age))
						}
					} else {
						// Health poll succeeded — restore if unhealthy
						b.mu.RLock()
						wasUnhealthy := !b.Healthy
						b.mu.RUnlock()
						if wasUnhealthy {
							b.markHealthy()
						}
						b.consecutiveFails.Store(0)
					}
				}(b)
			}
		}
	}()
}

// ─── Math Helpers ──────────────────────────────────────────────────────────────

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func round1(f float64) float64 {
	return math.Round(f*10) / 10
}

// ─── Main ─────────────────────────────────────────────────────────────────────

func main() {
	// Parse flags (override environment defaults)
	portFlag      := flag.Int("port", 0, "LB port (overrides LB_PORT env)")
	backendsFlag  := flag.String("backends", "", "Comma-separated backend URLs (overrides BACKENDS env)")
	tlsFlag       := flag.Bool("tls", false, "Enable HTTPS on LB")
	certFlag      := flag.String("cert", "", "TLS cert file (overrides TLS_CERT env)")
	keyFlag       := flag.String("key", "", "TLS key file (overrides TLS_KEY env)")
	overloadFlag  := flag.Float64("overload", 0, "Overload threshold 0-100 (overrides OVERLOAD_THRESHOLD env)")
	recoveryFlag  := flag.Float64("recovery", 0, "Recovery threshold 0-100 (overrides RECOVERY_THRESHOLD env)")
	flag.Parse()

	cfg := loadConfig()

	// Apply flag overrides
	if *portFlag > 0     { cfg.Port = *portFlag }
	if *backendsFlag != "" { cfg.Backends = strings.Split(*backendsFlag, ",") }
	if *tlsFlag           { cfg.TLSEnabled = true }
	if *certFlag != ""    { cfg.CertFile = *certFlag }
	if *keyFlag != ""     { cfg.KeyFile = *keyFlag }
	if *overloadFlag > 0  { cfg.OverloadThreshold = *overloadFlag }
	if *recoveryFlag > 0  { cfg.RecoveryThreshold = *recoveryFlag }

	log.SetFlags(log.Ltime | log.Lmicroseconds)
	log.Printf("[LB] ══════════════════════════════════════")
	log.Printf("[LB] Dynamic Performance Load Balancer")
	log.Printf("[LB] Port:               :%d", cfg.Port)
	log.Printf("[LB] TLS:                %v", cfg.TLSEnabled)
	log.Printf("[LB] Backends:           %v", cfg.Backends)
	log.Printf("[LB] Overload threshold: %.0f", cfg.OverloadThreshold)
	log.Printf("[LB] Recovery threshold: %.0f", cfg.RecoveryThreshold)
	log.Printf("[LB] Heartbeat timeout:  %v", cfg.HeartbeatTimeout)
	log.Printf("[LB] Retry max:          %d", cfg.RetryMax)
	log.Printf("[LB] Score weights:      Q=%.2f CPU=%.2f Mem=%.2f Act=%.2f RT=%.2f",
		cfg.WQueue, cfg.WCPU, cfg.WMemory, cfg.WActive, cfg.WRespTime)
	log.Printf("[LB] ══════════════════════════════════════")

	lb := newLB(cfg)
	lb.startHealthPoller()

	mux := http.NewServeMux()

	// Internal LB management routes
	mux.HandleFunc("/lb/heartbeat", lb.handleHeartbeat)
	mux.HandleFunc("/lb/metrics",   lb.handleLBMetrics)
	mux.HandleFunc("/lb/health",    lb.handleHealth)

	// All other traffic → proxy to best backend
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// WebSocket / Socket.IO upgrade
		if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			lb.proxyWebSocket(w, r)
			return
		}
		lb.proxyRequest(w, r)
	})

	addr := fmt.Sprintf("0.0.0.0:%d", cfg.Port)
	srv := &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  60 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	if cfg.TLSEnabled {
		log.Printf("[LB] Starting HTTPS server on %s", addr)
		log.Fatal(srv.ListenAndServeTLS(cfg.CertFile, cfg.KeyFile))
	} else {
		log.Printf("[LB] Starting HTTP server on %s", addr)
		log.Fatal(srv.ListenAndServe())
	}
}

// Ensure context is imported (used by http.Server)
var _ = context.Background
