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

# Install Node dependencies, then apply two patches for Alpine/musl compatibility
# with @huggingface/transformers (which defaults to onnxruntime-node, a glibc binary):
#
# Patch 1 — transformers package.json: remove the "node" export condition so Node.js
# loads transformers.web.js (the web bundle) instead of transformers.node.cjs.
# The web bundle stubs onnxruntime-node to {}, preventing the dlopen crash.
#
# Patch 2 — transformers.web.js: in the ORT_SYMBOL branch (taken when imageProcessor.js
# pre-populates globalThis[ORT_SYMBOL] with onnxruntime-web/wasm at module load time),
# the bundle sets ONNX but leaves supportedDevices=[]. Add 'wasm' and 'cpu' so that
# device:'wasm' passes the deviceToExecutionProviders() check.
RUN npm ci --only=production && \
    python3 -c "import json; p='/app/node_modules/@huggingface/transformers/package.json'; d=json.load(open(p)); d['exports'].pop('node', None); json.dump(d, open(p,'w'), indent=2); print('Patch 1: removed node export condition from @huggingface/transformers')" && \
    python3 -c "p='/app/node_modules/@huggingface/transformers/dist/transformers.web.js'; src=open(p).read(); old='ONNX = globalThis[ORT_SYMBOL];'; new='ONNX = globalThis[ORT_SYMBOL]; if (!supportedDevices.includes(\"wasm\")) { supportedDevices.push(\"wasm\", \"cpu\"); defaultDevices = [\"wasm\"]; }'; assert old in src, 'Patch 2 target not found'; open(p,'w').write(src.replace(old, new, 1)); print('Patch 2: added wasm+cpu to supportedDevices in ORT_SYMBOL branch of transformers.web.js')"

# Copy application files
COPY app/ ./

# Create run script
COPY run.sh /
RUN chmod a+x /run.sh

# Expose port
EXPOSE 8099

# Run the add-on
CMD [ "/run.sh" ]
