# Bruno CLI — Debian

Debian slim variant of the Bruno CLI Docker image.

**Base image:** `node:22-slim`

## Building

```bash
docker build -t usebruno/cli:debian ./images/debian

# with specific Bruno CLI version
docker build \
  --build-arg BRUNO_VERSION=3.3.0 \
  -t usebruno/cli:3.3.0-debian \
  ./images/debian
```

## Usage

```bash
# Docker Hub
docker run --rm -v $(pwd):/bruno usebruno/cli:debian run --env staging
docker run --rm -v $(pwd):/bruno usebruno/cli:3.3.0-debian run --env staging

# GHCR
docker run --rm -v $(pwd):/bruno ghcr.io/usebruno/cli:debian run --env staging
docker run --rm -v $(pwd):/bruno ghcr.io/usebruno/cli:3.3.0-debian run --env staging
```
