# FROM mcr.microsoft.com/playwright:v1.20.0
# Partially from https://github.com/microsoft/playwright/blob/main/utils/docker/Dockerfile.focal
FROM ubuntu:jammy@sha256:0a9887931b0e38af2e3487ed39e29436b0535c4f3f52e57745baaf79d1898956

# Configuration variables are at the end!

# https://github.com/hadolint/hadolint/wiki/DL4006
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG DEBIAN_FRONTEND=noninteractive

# Install up-to-date node & npm, deps for virtual screen & noVNC, firefox, pip for apprise.
RUN apt-get update \
    && apt-get install --no-install-recommends -y curl=7.81.0-1ubuntu1.30 ca-certificates=20260816ubuntu0.22.04.1 gnupg=2.2.27-3ubuntu2.5 \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install --no-install-recommends -y \
      nodejs=20.20.2-1nodesource1 \
      xvfb=2:21.1.4-2ubuntu1.7~22.04.16 \
      x11vnc=0.9.16-8 \
      tini=0.19.0-1 \
      novnc=1:1.0.0-5 websockify=0.10.0+dfsg1-2build1 \
      dos2unix=7.4.2-2 \
      python3-pip=22.0.2+dfsg-1ubuntu0.7 \
    # && npx playwright install-deps firefox \
    && apt-get install --no-install-recommends -y \
      libgtk-3-0=3.24.33-1ubuntu2.2 \
      libasound2=1.2.6.1-1ubuntu1.2 \
      libxcomposite1=1:0.4.5-1build2 \
      libpangocairo-1.0-0=1.50.6+ds-2ubuntu1 \
      libpango-1.0-0=1.50.6+ds-2ubuntu1 \
      libatk1.0-0=2.36.0-3build1 \
      libcairo-gobject2=1.16.0-5ubuntu2.1 \
      libcairo2=1.16.0-5ubuntu2.1 \
      libgdk-pixbuf-2.0-0=2.42.8+dfsg-1ubuntu0.5 \
      libdbus-glib-1-2=0.112-2build1 \
      libxcursor1=1:1.2.0-2build4 \
    && apt-get autoremove -y \
    && apt-get clean \
    && rm -rf \
      /tmp/* \
      /usr/share/doc/* \
      /var/cache/* \
      /var/lib/apt/lists/* \
      /var/tmp/*

# RUN node --version
# RUN npm --version

RUN ln -s /usr/share/novnc/vnc_auto.html /usr/share/novnc/index.html \
    && pip install --no-cache-dir apprise==2.0.1

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright

WORKDIR /fgc
COPY package*.json ./

# Playwright installs patched firefox to ~/.cache/ms-playwright/firefox-*
# Requires some system deps to run (see inlined install-deps above).
RUN npm install
# Old: PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD + install firefox (had to be done after `npm install` to get the correct version). Now: playwright-firefox as npm dep and `npm install` will only install that.
# From 1.38 Playwright will no longer install browser automatically for playwright, but apparently still for playwright-firefox: https://github.com/microsoft/playwright/releases/tag/v1.38.0
# RUN npx playwright install firefox

COPY . .

# Shell scripts need Linux line endings. On Windows, git might be configured to check out dos/CRLF line endings, so we convert them for those people in case they want to build the image. They could also use --config core.autocrlf=input
RUN dos2unix ./*.sh && chmod +x ./*.sh \
    && groupadd --gid 1000 fgc \
    && useradd --uid 1000 --gid 1000 --create-home fgc \
    && mkdir -p /fgc/data /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix \
    && chown -R 1000:1000 /fgc/data
COPY docker-entrypoint.sh /usr/local/bin/

ARG COMMIT=""
ARG BRANCH=""
ARG NOW=""
ENV COMMIT=${COMMIT}
ENV BRANCH=${BRANCH}
ENV NOW=${NOW}

LABEL org.opencontainers.image.title="free-games-claimer" \
      org.opencontainers.image.name="free-games-claimer" \
      org.opencontainers.image.description="Automatically claims free games on the Epic Games Store, Amazon Prime Gaming and GOG" \
      org.opencontainers.image.url="https://github.com/daddyparodz/free-games-claimer" \
      org.opencontainers.image.source="https://github.com/daddyparodz/free-games-claimer" \
      org.opencontainers.image.revision=${COMMIT} \
      org.opencontainers.image.ref.name=${BRANCH} \
      org.opencontainers.image.base.name="ubuntu:jammy" \
      org.opencontainers.image.version="latest"

# Configure VNC via environment variables:
ENV VNC_PORT=5900
ENV NOVNC_PORT=6080
EXPOSE 5900
EXPOSE 6080

# Configure Xvfb via environment variables:
ENV WIDTH=1920
ENV HEIGHT=1080
ENV DEPTH=24

# Show browser instead of running headless
ENV SHOW=1

# Readiness of local display transports, not proof of successful account claims.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["/bin/bash", "-c", "test -S /tmp/.X11-unix/X1 && echo > /dev/tcp/127.0.0.1/\"$VNC_PORT\" && echo > /dev/tcp/127.0.0.1/\"$NOVNC_PORT\""]

USER 1000:1000

# Script to setup display server & VNC is always executed.
ENTRYPOINT ["docker-entrypoint.sh"]
# Default command to run. This is replaced by appending own command, e.g. `docker run ... node prime-gaming` to only run this script.
CMD ["/bin/bash", "-c", "node epic-games; node prime-gaming; node gog"]
