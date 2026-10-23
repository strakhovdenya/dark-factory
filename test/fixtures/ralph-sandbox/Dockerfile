# syntax=docker/dockerfile:1
# Derived stub image of the Ralph Docker integration. Built only by
# test/integration/prepare-ralph-sandbox.js, FROM the source image that the package's own
# sandbox.buildImage built (SOURCE_IMAGE). Adds, without touching the package's files in the image:
#   - the stub `claude` first in PATH (the real pinned CLI stays at its own path);
#   - the fixture commands, probes and the controlled HTTPS service with its test certificate;
#   - the prepared factory copy with its runtime dependencies (named context `factory`), which the
#     test install command lays out in a clone's node_modules without any registry.
ARG SOURCE_IMAGE=ralph-sandbox-it:source
FROM ${SOURCE_IMAGE}

COPY --chmod=0755 stub/claude.js /opt/ralph-fixture/stub/claude.js
COPY lib/ /opt/ralph-fixture/lib/
COPY bin/ /opt/ralph-fixture/bin/
COPY service/ /opt/ralph-fixture/service/
COPY --from=factory . /opt/ralph-fixture/factory/node_modules/

USER root
RUN mkdir -p /opt/ralph-stub/bin \
  && printf '#!/bin/sh\nexec node /opt/ralph-fixture/stub/claude.js "$@"\n' > /opt/ralph-stub/bin/claude \
  && chmod 0755 /opt/ralph-stub/bin/claude \
  && chmod -R a+rX /opt/ralph-fixture
USER node

ENV PATH=/opt/ralph-stub/bin:${PATH}
