# Makefile for the C reference SocialPoster WebAssembly plugin.
# Requires clang with WASI sysroot (e.g. WASI SDK at /opt/wasi-sdk/bin/clang).

CC      ?= /opt/wasi-sdk/bin/clang
OUT     ?= ../output/example-social-c.wasm
CFLAGS  ?= --target=wasm32-wasi -O2 -Wall -Wextra -mexec-model=reactor
LDFLAGS ?=

.PHONY: all clean

all: $(OUT)

$(OUT): plugin.c extism-pdk.h
	@mkdir -p $(dir $(OUT))
	$(CC) $(CFLAGS) $(LDFLAGS) -o $(OUT) plugin.c

clean:
	rm -f $(OUT)
