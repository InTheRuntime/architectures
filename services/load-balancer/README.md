# HTTP Reverse Proxy & Load Balancer (`services/load-balancer`)

A production-grade, standalone HTTP Reverse Proxy and Load Balancer featuring **Round-Robin** and **Least-Connections** routing, **Active Background Health Checks**, and dynamic backend administration.

---

## Features

- **Multiple Balancing Algorithms**: Switch seamlessly between Round-Robin and Least-Connections.
- **Active Health Checking**: Background state machine automatically ejects failed backends and restores recovered ones without dropping traffic.
- **Dynamic Pool Management**: Add and remove upstream backend instances at runtime via admin APIs without restarting the proxy.
- **Graceful 502 Bad Gateway**: Clean, structured error handling when all upstreams are unavailable.
- **Distributed Tracing**: Generates and propagates `X-Request-Id` and `X-Forwarded-*` headers.

---

## Quickstart

### 1. Run the Load Balancer

```bash
pnpm --filter @intheruntime/service-load-balancer start
```
*Listens on `http://localhost:8080`.*

---

## API & Administration Endpoints

### 1. Proxy Traffic
Send any standard HTTP request to the load balancer:
```bash
curl http://localhost:8080/api/users
```
The balancer forwards the request to an active, healthy backend node and returns the upstream response.

### 2. View Backend Health & Status
```bash
curl http://localhost:8080/_admin/targets
```
Response:
```json
{
  "algorithm": "round-robin",
  "total_targets": 2,
  "healthy_targets": 2,
  "targets": [
    {
      "url": "http://127.0.0.1:8081",
      "healthy": true,
      "active_connections": 0,
      "consecutive_failures": 0,
      "consecutive_successes": 5
    },
    {
      "url": "http://127.0.0.1:8082",
      "healthy": true,
      "active_connections": 0,
      "consecutive_failures": 0,
      "consecutive_successes": 5
    }
  ]
}
```

### 3. Dynamically Register a New Backend
```bash
curl -X POST http://localhost:8080/_admin/targets \
  -H "Content-Type: application/json" \
  -d '{ "url": "http://127.0.0.1:8083" }'
```

### 4. Switch Balancing Algorithm
```bash
curl -X POST http://localhost:8080/_admin/algorithm \
  -H "Content-Type: application/json" \
  -d '{ "algorithm": "least-connections" }'
```
