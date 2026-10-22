# syntax=docker/dockerfile:1
# Ralph sandbox image: node + git + the pinned `claude` CLI. Built by the controller at startup
# (sandbox.js buildImage) from this directory of the installed package, never from the consumer's
# checkout; the `ralph` named context is the parent directory and supplies sandbox.js for proxy.js.
ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm-slim

ARG CLAUDE_CODE_VERSION
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && npm cache clean --force

# The clone is created on the host and may belong to another uid; no credential helper of any
# kind; HOME is world-writable so any --user uid has one without an extra mount.
RUN git config --system --add safe.directory '*' \
  && git config --system credential.helper '' \
  && mkdir -p /home/sandbox \
  && chmod 1777 /home/sandbox

COPY --from=ralph sandbox.js /opt/ralph/sandbox.js
COPY proxy.js /opt/ralph/sandbox/proxy.js

ENV HOME=/home/sandbox
USER node
WORKDIR /workspace
