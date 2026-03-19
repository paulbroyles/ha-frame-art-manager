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

# Install Node dependencies
RUN npm ci --only=production

# Alpine compatibility patch for @huggingface/transformers:
# The package's "node" export condition loads a Node.js-specific bundle that
# requires onnxruntime-node (glibc binary, incompatible with Alpine musl).
# Removing it forces Node.js to load the browser/WASM bundle instead, which
# uses onnxruntime-web (pure WASM, Alpine-safe).
RUN node -e "\
const fs=require('fs');\
const p='node_modules/@huggingface/transformers/package.json';\
const pkg=JSON.parse(fs.readFileSync(p,'utf8'));\
function stripNode(o){if(typeof o!=='object'||o===null)return o;const r={};for(const[k,v]of Object.entries(o))if(k!=='node')r[k]=stripNode(v);return r;}\
if(pkg.exports)pkg.exports=stripNode(pkg.exports);\
fs.writeFileSync(p,JSON.stringify(pkg,null,2));\
console.log('Alpine patch: removed node export condition from @huggingface/transformers');\
"

# Copy application files
COPY app/ ./

# Create run script
COPY run.sh /
RUN chmod a+x /run.sh

# Expose port
EXPOSE 8099

# Run the add-on
CMD [ "/run.sh" ]
