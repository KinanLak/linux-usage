APP_NAME=Linux Usage
EXECUTABLE=LinuxUsage
BUNDLE_ID=io.github.kinanlak.linux-usage
VERSION?=0.1.0
BUILD?=$(shell git rev-list --count HEAD 2>/dev/null || echo 1)
BUILD_DIR=build
APP=$(BUILD_DIR)/$(APP_NAME).app
ZIP=$(BUILD_DIR)/linux-usage-macos.zip
INSTALL_DIR?=$(HOME)/Applications
# Universal binary by default; `make ARCHS=arm64` for a faster local build.
ARCHS?=arm64 x86_64
ARCH_FLAGS=$(foreach arch,$(ARCHS),--arch $(arch))
SOURCES=$(shell find Sources -name '*.swift') Package.swift

.PHONY: all app zip run install debug dev snapshot icon clean

all: app

# The bundle path has a space, which make can't use as a target: track it with a stamp file.
STAMP=$(BUILD_DIR)/.app-stamp

app: $(STAMP)

$(STAMP): $(SOURCES) Resources/Info.plist Resources/AppIcon.icns
	swift build -c release $(ARCH_FLAGS)
	rm -rf "$(APP)"
	mkdir -p "$(APP)/Contents/MacOS" "$(APP)/Contents/Resources"
	cp "$$(swift build -c release $(ARCH_FLAGS) --show-bin-path)/$(EXECUTABLE)" "$(APP)/Contents/MacOS/$(EXECUTABLE)"
	cp Resources/AppIcon.icns "$(APP)/Contents/Resources/AppIcon.icns"
	sed -e 's/__VERSION__/$(VERSION)/' -e 's/__BUILD__/$(BUILD)/' Resources/Info.plist > "$(APP)/Contents/Info.plist"
	codesign --force --sign - --identifier "$(BUNDLE_ID)" "$(APP)"
	touch "$@"

zip: app
	rm -f "$(ZIP)"
	cd "$(BUILD_DIR)" && ditto -c -k --keepParent "$(APP_NAME).app" "$(notdir $(ZIP))"

# Quit the running copy, install to ~/Applications and relaunch.
install: app
	-osascript -e 'quit app id "$(BUNDLE_ID)"' 2>/dev/null
	mkdir -p "$(INSTALL_DIR)"
	rm -rf "$(INSTALL_DIR)/$(APP_NAME).app"
	ditto "$(APP)" "$(INSTALL_DIR)/$(APP_NAME).app"
	open "$(INSTALL_DIR)/$(APP_NAME).app"

run: app
	-osascript -e 'quit app id "$(BUNDLE_ID)"' 2>/dev/null
	open "$(APP)"

# Print the provider snapshot JSON, like `gjs helper/helper.js snapshot --pretty`.
snapshot: app
	"$(APP)/Contents/MacOS/$(EXECUTABLE)" snapshot --pretty

debug:
	swift build

# Debug build wrapped in its own bundle (a bare binary gets no menu bar item), e.g.
#   make dev ARGS="--sample --popup-window"
DEV_APP=$(BUILD_DIR)/$(APP_NAME) Dev.app
dev: debug
	-osascript -e 'quit app id "$(BUNDLE_ID).dev"' 2>/dev/null
	mkdir -p "$(DEV_APP)/Contents/MacOS" "$(DEV_APP)/Contents/Resources"
	cp "$$(swift build --show-bin-path)/$(EXECUTABLE)" "$(DEV_APP)/Contents/MacOS/$(EXECUTABLE)"
	cp Resources/AppIcon.icns "$(DEV_APP)/Contents/Resources/AppIcon.icns"
	sed -e 's/__VERSION__/$(VERSION)-dev/' -e 's/__BUILD__/$(BUILD)/' -e 's/$(BUNDLE_ID)/$(BUNDLE_ID).dev/' \
		Resources/Info.plist > "$(DEV_APP)/Contents/Info.plist"
	codesign --force --sign - "$(DEV_APP)"
	open -n "$(DEV_APP)" --args $(ARGS)

# Regenerate Resources/AppIcon.icns from scripts/make-icon.swift.
icon:
	rm -rf "$(BUILD_DIR)/AppIcon.iconset"
	mkdir -p "$(BUILD_DIR)"
	swift scripts/make-icon.swift "$(BUILD_DIR)/AppIcon.iconset"
	iconutil -c icns "$(BUILD_DIR)/AppIcon.iconset" -o Resources/AppIcon.icns

clean:
	rm -rf .build "$(BUILD_DIR)"
