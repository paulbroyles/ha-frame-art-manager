ARG BUILD_FROM
FROM $BUILD_FROM

# Set shell
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Install Node.js, git, and git-lfs
RUN apk add --no-cache \
    nodejs \
    npm \
    git \
    git-lfs \
    openssh-client \
    python3 \
    make \
    g++ \
    jq \
    curl \
    gcompat \
    && git lfs install

# Install dezoomify-rs for high-resolution image downloads from tile-based sources
# (e.g., Google Arts & Culture deep zoom). gcompat above provides glibc compatibility
# so the standard Linux glibc binary works on Alpine.
# Source: https://github.com/nicokosi/dezoomify-rs/releases/tag/v2.15.0
RUN curl -fsSL https://github.com/nicokosi/dezoomify-rs/releases/download/v2.15.0/dezoomify-rs-linux.tgz \
    | tar -xz -C /usr/local/bin/ \
    && chmod +x /usr/local/bin/dezoomify-rs

# Set working directory
WORKDIR /app

# Copy package files
COPY app/package*.json ./

# Install Node dependencies
RUN npm ci --only=production

# Copy application files
COPY app/ ./

# Create run script
COPY run.sh /
RUN chmod a+x /run.sh

# Expose port
EXPOSE 8099

# Run the add-on
CMD [ "/run.sh" ]
