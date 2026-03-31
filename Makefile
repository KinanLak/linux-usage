NAME=linux-usage
UUID=linux-usage@kinanl
DIST_DIR=dist
ZIP_PATH=packaging/extension-bundle/$(UUID).zip
ZIP_ABS=$(abspath $(ZIP_PATH))
TS_SOURCES=$(shell find ts/extension -type f -name '*.ts' | sort)
STATIC_ASSETS=$(shell find extension -type f ! -name '*.js' ! -name 'gschemas.compiled' | sort)
BUILD_FILES=package.json package-lock.json tsconfig.json ts/ambient.d.ts scripts/build-extension.mjs scripts/typecheck-extension.mjs

.PHONY: all pack install clean check

all: $(DIST_DIR)/extension.js

node_modules/.package-lock.json: package.json
	npm install

$(DIST_DIR)/extension.js: node_modules/.package-lock.json $(TS_SOURCES) $(STATIC_ASSETS) $(BUILD_FILES)
	npm run build:extension

$(DIST_DIR)/schemas/gschemas.compiled: $(DIST_DIR)/extension.js
	glib-compile-schemas $(DIST_DIR)/schemas

$(ZIP_PATH): $(DIST_DIR)/schemas/gschemas.compiled
	@mkdir -p $(dir $@)
	@rm -f $@
	@(cd $(DIST_DIR) && zip -qr "$(ZIP_ABS)" .)

pack: $(ZIP_PATH)

install: $(ZIP_PATH)
	gnome-extensions install --force $(ZIP_PATH)

check: node_modules/.package-lock.json
	npm run check:extension

clean:
	npm run clean:extension
	rm -rf node_modules $(ZIP_PATH)
