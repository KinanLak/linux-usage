NAME=linux-usage
DIST_DIR=dist
SCHEMAS_DIR=src/extension/schemas
SCHEMA_FILE=$(SCHEMAS_DIR)/org.gnome.shell.extensions.linux-usage.gschema.xml
ZIP_PATH=$(NAME).zip
TS_SOURCES=$(shell find src -type f -name '*.ts' | sort)
STATIC_ASSETS=$(shell find src/extension -type f ! -name '*.ts' ! -name '*.js' ! -name 'gschemas.compiled' | sort)
BUILD_FILES=package.json package-lock.json tsconfig.json scripts/build-extension.mjs scripts/typecheck-extension.mjs

.PHONY: all pack install clean check

all: $(DIST_DIR)/extension.js

node_modules/.package-lock.json: package.json package-lock.json
	npm install

$(DIST_DIR)/extension.js $(DIST_DIR)/prefs.js: node_modules/.package-lock.json $(TS_SOURCES) $(STATIC_ASSETS) $(BUILD_FILES)
	npm run build

$(SCHEMAS_DIR)/gschemas.compiled: $(SCHEMA_FILE)
	glib-compile-schemas $(SCHEMAS_DIR)

$(ZIP_PATH): $(DIST_DIR)/extension.js $(DIST_DIR)/prefs.js $(SCHEMAS_DIR)/gschemas.compiled
	@rm -f $@
	@cp $(SCHEMAS_DIR)/gschemas.compiled $(DIST_DIR)/schemas/
	@(cd $(DIST_DIR) && zip -qr ../$(ZIP_PATH) .)

pack: $(ZIP_PATH)

install: $(ZIP_PATH)
	gnome-extensions install --force $(ZIP_PATH)

check: node_modules/.package-lock.json
	npm run check

clean:
	npm run clean
	rm -rf node_modules $(ZIP_PATH) $(SCHEMAS_DIR)/gschemas.compiled
