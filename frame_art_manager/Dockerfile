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
    gcompat \
    && git lfs install

# Set working directory
WORKDIR /app

# Copy package files
COPY app/package*.json ./

# Install Node dependencies, then patch @huggingface/transformers so Node.js uses
# the web bundle (transformers.web.js → onnxruntime-web WASM) instead of the node
# bundle (transformers.node.cjs → onnxruntime-node native). The node bundle has no
# WASM fallback path and its native binary requires glibc symbols absent on Alpine.
RUN npm ci --only=production && \
    python3 -c "import json; p='/app/node_modules/@huggingface/transformers/package.json'; d=json.load(open(p)); d['exports']['.'].pop('node', None); json.dump(d, open(p,'w'), indent=2); print('Patched @huggingface/transformers: removed node export condition')"

# Copy application files
COPY app/ ./

# Create run script
COPY run.sh /
RUN chmod a+x /run.sh

# Expose port
EXPOSE 8099

# Run the add-on
CMD [ "/run.sh" ]
