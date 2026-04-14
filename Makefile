NAME=linux-usage
DIST_DIR=dist
LEGACY_DIST_DIR=dist-pre45
EXTENSION_SRC_DIR=src/extension
SCHEMAS_DIR=src/extension/schemas
SCHEMA_FILE=$(SCHEMAS_DIR)/org.gnome.shell.extensions.linux-usage.gschema.xml
ZIP_PATH=$(NAME).zip
LEGACY_ZIP_PATH=$(NAME)-pre45.zip
TS_SOURCES=$(shell find src -type f -name '*.ts' | sort)
STATIC_ASSETS=$(shell find $(EXTENSION_SRC_DIR) -type f ! -name '*.ts' ! -name '*.js' ! -name 'metadata.json' ! -name 'gschemas.compiled' | sort)
BUILD_FILES=package.json bun.lock tsconfig.json Makefile scripts/build-legacy-gjs.mjs scripts/write-metadata.mjs

.PHONY: all build-esm build-legacy pack pack-esm pack-legacy install install-esm install-legacy clean clean-dist check

all: $(DIST_DIR)/.bundle-stamp $(LEGACY_DIST_DIR)/.bundle-stamp

build-esm: $(DIST_DIR)/.bundle-stamp

build-legacy: $(LEGACY_DIST_DIR)/.bundle-stamp

node_modules/.install-stamp: package.json bun.lock
	bun install --frozen-lockfile
	@touch $@

$(SCHEMAS_DIR)/gschemas.compiled: $(SCHEMA_FILE)
	glib-compile-schemas $(SCHEMAS_DIR)

$(DIST_DIR)/.bundle-stamp: node_modules/.install-stamp $(TS_SOURCES) $(STATIC_ASSETS) $(BUILD_FILES) $(SCHEMAS_DIR)/gschemas.compiled
	rm -rf "$(DIST_DIR)"
	bun x tsc --project tsconfig.json --noEmit false --noCheck --rootDir src --outDir "$(DIST_DIR)"
	cp -r "$(DIST_DIR)/extension/." "$(DIST_DIR)/"
	rm -rf "$(DIST_DIR)/extension"
	for asset in $(STATIC_ASSETS); do \
		target="$(DIST_DIR)/$${asset#$(EXTENSION_SRC_DIR)/}"; \
		mkdir -p "$$(dirname "$$target")"; \
		cp "$$asset" "$$target"; \
	done
	node ./scripts/write-metadata.mjs esm "$(EXTENSION_SRC_DIR)/metadata.json" "$(DIST_DIR)/metadata.json"
	chmod 755 "$(DIST_DIR)/preferences-app.js" "$(DIST_DIR)/helper/helper.js"
	touch "$@"

$(LEGACY_DIST_DIR)/.bundle-stamp: $(DIST_DIR)/.bundle-stamp $(BUILD_FILES) $(SCHEMAS_DIR)/gschemas.compiled
	rm -rf "$(LEGACY_DIST_DIR)"
	cp -r "$(DIST_DIR)" "$(LEGACY_DIST_DIR)"
	node ./scripts/write-metadata.mjs legacy "$(EXTENSION_SRC_DIR)/metadata.json" "$(LEGACY_DIST_DIR)/metadata.json"
	node ./scripts/build-legacy-gjs.mjs "$(LEGACY_DIST_DIR)"
	mkdir -p "$(LEGACY_DIST_DIR)/schemas"
	cp "$(SCHEMAS_DIR)/gschemas.compiled" "$(LEGACY_DIST_DIR)/schemas/gschemas.compiled"
	chmod 755 "$(LEGACY_DIST_DIR)/preferences-app.js" "$(LEGACY_DIST_DIR)/helper/helper.js"
	touch "$@"

$(ZIP_PATH): $(DIST_DIR)/.bundle-stamp
	@rm -f $@
	@(cd $(DIST_DIR) && zip -qr ../$(ZIP_PATH) .)

$(LEGACY_ZIP_PATH): $(LEGACY_DIST_DIR)/.bundle-stamp
	@rm -f $@
	@(cd $(LEGACY_DIST_DIR) && zip -qr ../$(LEGACY_ZIP_PATH) .)

pack: $(ZIP_PATH) $(LEGACY_ZIP_PATH)

pack-esm: $(ZIP_PATH)

pack-legacy: $(LEGACY_ZIP_PATH)

install: $(ZIP_PATH) $(LEGACY_ZIP_PATH)
	@printf '%s\n' 'Use make install-esm or make install-legacy.'
	@false

install-esm: $(ZIP_PATH)
	gnome-extensions install --force $(ZIP_PATH)
	gnome-extensions disable "linux-usage@KinanLak.github.io"
	gnome-extensions enable "linux-usage@KinanLak.github.io"

install-legacy: $(LEGACY_ZIP_PATH)
	gnome-extensions install --force $(LEGACY_ZIP_PATH)
	gnome-extensions disable "linux-usage@KinanLak.github.io"
	gnome-extensions enable "linux-usage@KinanLak.github.io"

check: node_modules/.install-stamp
	bun run check

clean-dist:
	rm -rf $(DIST_DIR) $(LEGACY_DIST_DIR)

clean:
	$(MAKE) clean-dist
	rm -rf node_modules $(ZIP_PATH) $(LEGACY_ZIP_PATH) $(SCHEMAS_DIR)/gschemas.compiled
