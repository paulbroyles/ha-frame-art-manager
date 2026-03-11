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

# Install Node dependencies, then remove onnxruntime-node's native binary.
# The prebuilt binary requires glibc symbols (e.g. __vsnprintf_chk) absent from
# Alpine/musl. Removing it causes a clean ENOENT on require(), which
# @huggingface/transformers catches and handles by falling back to the WASM backend.
# ERR_DLOPEN_FAILED (the alternative) is not cleanly catchable and crashes Node.
RUN npm ci --only=production && \
    find /app/node_modules -name "onnxruntime_binding.node" -delete 2>/dev/null; true

# Copy application files
COPY app/ ./

# Create run script
COPY run.sh /
RUN chmod a+x /run.sh

# Expose port
EXPOSE 8099

# Run the add-on
CMD [ "/run.sh" ]
