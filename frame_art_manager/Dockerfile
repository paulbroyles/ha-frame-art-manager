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
    py3-pip \
    py3-pillow \
    make \
    g++ \
    jq \
    curl \
    gcompat \
    libc6-compat \
    && git lfs install

# Install dezoomify-rs for high-resolution image downloads from tile-based sources
# (e.g., Google Arts & Culture deep zoom). dezoomify-rs is a glibc binary; gcompat
# maps most glibc calls to musl equivalents but does not provide __res_init from
# libresolv. The stub below fills that gap via LD_PRELOAD (see utils/dezoomify.js).
# Source: https://github.com/lovasoa/dezoomify-rs/releases/tag/v2.15.0
RUN curl -fsSL https://github.com/lovasoa/dezoomify-rs/releases/download/v2.15.0/dezoomify-rs-linux.tgz \
    | tar -xz -C /usr/local/bin/ \
    && chmod +x /usr/local/bin/dezoomify-rs

# Compile a stub shared library providing __res_init (missing from Alpine's musl libc).
# Loaded via LD_PRELOAD scoped to the dezoomify-rs subprocess only.
RUN printf 'int __res_init(void) { return 0; }\n' \
    | gcc -shared -fPIC -nostdlib -o /usr/local/lib/libres_stub.so -x c -

# Set working directory
WORKDIR /app

# Copy package files
COPY app/package*.json ./

# Install Node dependencies, then apply three patches for Alpine/musl compatibility
# with @huggingface/transformers (which defaults to onnxruntime-node, a glibc binary):
#
# Patch 1 — transformers package.json: remove the "node" export condition so Node.js
# loads transformers.web.js (the web bundle) instead of transformers.node.cjs.
#
# Patch 2 — transformers.web.js: in the ORT_SYMBOL branch (taken when mlSubject.js
# pre-populates globalThis[ORT_SYMBOL] with onnxruntime-web at module load time),
# the bundle sets ONNX but leaves supportedDevices=[]. Add 'wasm' and 'cpu' so that
# device:'wasm' passes the deviceToExecutionProviders() check.
#
# Patch 3 — transformers.web.js: the web bundle mocks sharp as (ignored), returning {}.
# Replace with globalThis.__nativeSharp (pre-loaded by the CJS IIFE in mlSubject.js).
RUN npm ci --only=production && \
    python3 -c "import json; p='/app/node_modules/@huggingface/transformers/package.json'; d=json.load(open(p)); d['exports'].pop('node', None); json.dump(d, open(p,'w'), indent=2); print('Patch 1: removed node export condition from @huggingface/transformers')" && \
    python3 -c "p='/app/node_modules/@huggingface/transformers/dist/transformers.web.js'; src=open(p).read(); old='ONNX = globalThis[ORT_SYMBOL];'; new='ONNX = globalThis[ORT_SYMBOL]; if (!supportedDevices.includes(\"wasm\")) { supportedDevices.push(\"wasm\", \"cpu\"); defaultDevices = [\"wasm\"]; }'; assert old in src, 'Patch 2 target not found'; open(p,'w').write(src.replace(old, new, 1)); print('Patch 2: added wasm+cpu to supportedDevices in ORT_SYMBOL branch of transformers.web.js')" && \
    python3 -c "p='/app/node_modules/@huggingface/transformers/dist/transformers.web.js'; src=open(p).read(); old='/***/ \"?2b25\":\n/*!***********************!*\\\\\n  !*** sharp (ignored) ***!\n  \\\\***********************/\n/***/ (() => {\n\n/* (ignored) */\n\n/***/ }),'; new='/***/ \"?2b25\":\n/*!***********************!*\\\\\n  !*** sharp (ignored) ***!\n  \\\\***********************/\n/***/ ((module) => {\nmodule.exports = globalThis.__nativeSharp;\n/***/ }),'; assert old in src, 'Patch 3 target not found'; open(p,'w').write(src.replace(old, new, 1)); print('Patch 3: replaced sharp (ignored) mock with globalThis.__nativeSharp in transformers.web.js')"

# Copy application files
COPY app/ ./

# Create run script
COPY run.sh /
RUN chmod a+x /run.sh

# Expose port
EXPOSE 8099

# Run the add-on
CMD [ "/run.sh" ]
