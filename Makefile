NAME=linux-usage
DOMAIN=kinanl
DIST_DIR=dist
SCHEMAS_DIR=extension/schemas
METADATA_FILE=extension/metadata.json
SCHEMA_FILE=$(SCHEMAS_DIR)/org.kinanl.linux-usage.gschema.xml
ZIP_PATH=$(NAME).zip
TS_SOURCES=$(shell find ts/extension -type f -name '*.ts' | sort)
STATIC_ASSETS=$(shell find extension -type f ! -name '*.js' ! -name 'gschemas.compiled' | sort)
BUILD_FILES=package.json package-lock.json tsconfig.json ts/ambient.d.ts scripts/build-extension.mjs scripts/typecheck-extension.mjs

.PHONY: all pack install clean check

all: $(DIST_DIR)/extension.js

node_modules/.package-lock.json: package.json package-lock.json
	npm install

$(DIST_DIR)/extension.js $(DIST_DIR)/prefs.js: node_modules/.package-lock.json $(TS_SOURCES) $(STATIC_ASSETS) $(BUILD_FILES)
	npm run build:extension

$(SCHEMAS_DIR)/gschemas.compiled: $(SCHEMA_FILE)
	glib-compile-schemas $(SCHEMAS_DIR)


$(ZIP_PATH): $(DIST_DIR)/extension.js $(DIST_DIR)/prefs.js $(SCHEMAS_DIR)/gschemas.compiled
	@rm -f $@
	@rm -rf $(DIST_DIR)/schemas
	@cp -r $(SCHEMAS_DIR) $(DIST_DIR)/
	@cp $(METADATA_FILE) $(DIST_DIR)/
	@(cd $(DIST_DIR) && zip -qr ../$(ZIP_PATH) .)

pack: $(ZIP_PATH)

install: $(ZIP_PATH)
	gnome-extensions install --force $(ZIP_PATH)

check: node_modules/.package-lock.json
	npm run check:extension

clean:
	npm run clean:extension
	rm -rf node_modules $(ZIP_PATH) $(SCHEMAS_DIR)/gschemas.compiled
