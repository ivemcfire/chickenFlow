"""
Dusk2Dawn 1.0.1 ships with two bugs that break builds on modern toolchains:

  1. `#include <Math.h>` (capital M) — fine on Windows/macOS but fails on
     Linux's case-sensitive filesystem where the header is `math.h`.
  2. Two out-of-line member function definitions (`min2str`, `zeroPadTime`) are
     written as `static bool Dusk2Dawn::foo(...)` — illegal since GCC 8 which
     rejects `static` linkage on qualified member definitions.

The library hasn't been updated since 2017. Until the upstream is forked we
auto-apply these patches on every `pio run`. This script is wired in via
`extra_scripts` in platformio.ini and is idempotent — re-running is safe.
"""
Import("env")
import os

LIB_DIR = os.path.join(env["PROJECT_DIR"], ".pio", "libdeps",
                        env["PIOENV"], "Dusk2Dawn")
HEADER  = os.path.join(LIB_DIR, "Dusk2Dawn.h")
SOURCE  = os.path.join(LIB_DIR, "Dusk2Dawn.cpp")


def patch(path, before, after, label):
    if not os.path.exists(path):
        return
    with open(path, "r") as f:
        body = f.read()
    if before in body:
        body = body.replace(before, after)
        with open(path, "w") as f:
            f.write(body)
        print("[patch_dusk2dawn] %s: %s" % (os.path.basename(path), label))


patch(HEADER, "#include <Math.h>", "#include <math.h>", "Math.h -> math.h")
patch(SOURCE, "#include <Math.h>", "#include <math.h>", "Math.h -> math.h")
patch(SOURCE,
      "static bool Dusk2Dawn::min2str",
      "bool Dusk2Dawn::min2str",
      "drop static on min2str()")
patch(SOURCE,
      "static bool Dusk2Dawn::zeroPadTime",
      "bool Dusk2Dawn::zeroPadTime",
      "drop static on zeroPadTime()")
