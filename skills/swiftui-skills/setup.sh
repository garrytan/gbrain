#!/bin/bash
# swiftui-skills setup
# Extracts Apple documentation from Xcode after npx skills install

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCS_DIR="$SCRIPT_DIR/docs"
METADATA_DIR="$SCRIPT_DIR/metadata"

CUSTOM_XCODE_PATH=""
CUSTOM_DOCS_PATH=""

# Colors (matching Vercel's npx skills style)
GRAY1='\033[38;5;250m'
GRAY2='\033[38;5;248m'
GRAY3='\033[38;5;245m'
GRAY4='\033[38;5;243m'
GRAY5='\033[38;5;240m'
GRAY6='\033[38;5;238m'
PINK='\033[38;5;174m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[38;5;102m'
NC='\033[0m'

# TUI helpers
print_banner() {
    echo ""
    echo -e "${GRAY1}███████╗██╗  ██╗██╗██╗     ██╗     ███████╗${NC}"
    echo -e "${GRAY2}██╔════╝██║ ██╔╝██║██║     ██║     ██╔════╝${NC}"
    echo -e "${GRAY3}███████╗█████╔╝ ██║██║     ██║     ███████╗${NC}"
    echo -e "${GRAY4}╚════██║██╔═██╗ ██║██║     ██║     ╚════██║${NC}"
    echo -e "${GRAY5}███████║██║  ██╗██║███████╗███████╗███████║${NC}"
    echo -e "${GRAY6}╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚══════╝╚══════╝${NC}"
    echo ""
}

print_header() {
    echo -e "┌   ${PINK}$1${NC}"
}

print_line() {
    echo "│"
}

print_step() {
    echo -e "◇  $1"
}

print_substep() {
    echo -e "│  $1"
}

print_success() {
    echo -e "◇  ${GREEN}$1${NC}"
}

print_warning() {
    echo -e "◇  ${YELLOW}$1${NC}"
}

print_error() {
    echo -e "◇  ${RED}$1${NC}"
}

print_footer() {
    echo -e "└  $1"
}

show_help() {
    print_banner
    echo "Extracts Apple documentation from Xcode to complete the skill installation."
    echo ""
    echo "Usage: setup.sh [options]"
    echo ""
    echo "Options:"
    echo "  --xcode-path PATH    Path to Xcode.app (if not in /Applications)"
    echo "  --docs-path PATH     Direct path to AdditionalDocumentation folder"
    echo "  --help               Show this help message"
    echo ""
    exit 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --xcode-path)
            CUSTOM_XCODE_PATH="$2"
            shift 2
            ;;
        --docs-path)
            CUSTOM_DOCS_PATH="$2"
            shift 2
            ;;
        --help|-h)
            show_help
            ;;
        *)
            print_error "Unknown option: $1"
            echo "    Use --help for usage information"
            exit 1
            ;;
    esac
done

find_docs_in_xcode() {
    local xcode_path="$1"
    local docs_path="${xcode_path}/Contents/PlugIns/IDEIntelligenceChat.framework/Versions/A/Resources/AdditionalDocumentation"

    if [ -d "$docs_path" ]; then
        echo "$docs_path"
        return 0
    fi

    docs_path="${xcode_path}/Contents/PlugIns/IDEIntelligenceChat.framework/Resources/AdditionalDocumentation"
    if [ -d "$docs_path" ]; then
        echo "$docs_path"
        return 0
    fi

    return 1
}

prompt_for_path() {
    print_line
    print_warning "Could not automatically find the documentation."
    print_line
    print_substep "Please enter one of the following:"
    print_substep "- Path to Xcode.app (e.g., /Applications/Xcode.app)"
    print_substep "- Path to AdditionalDocumentation folder"
    print_line
    read -p "│  Path: " user_path

    if [ -z "$user_path" ]; then
        print_error "No path provided"
        exit 1
    fi

    user_path="${user_path/#\~/$HOME}"

    if [[ "$user_path" == *"AdditionalDocumentation"* ]] || [ -f "$user_path"/*.md ] 2>/dev/null; then
        if [ -d "$user_path" ]; then
            XCODE_DOCS_PATH="$user_path"
            return 0
        fi
    fi

    if [[ "$user_path" == *".app" ]] && [ -d "$user_path" ]; then
        local found_path
        found_path=$(find_docs_in_xcode "$user_path")
        if [ -n "$found_path" ]; then
            XCODE_DOCS_PATH="$found_path"
            return 0
        fi
    fi

    print_error "Could not find AdditionalDocumentation at the provided path"
    print_substep "Make sure you have Xcode 26 or later installed"
    exit 1
}

# Start
print_banner
print_header "swiftui-skills setup"
print_line

# Determine docs path
XCODE_DOCS_PATH=""

if [ -n "$CUSTOM_DOCS_PATH" ]; then
    CUSTOM_DOCS_PATH="${CUSTOM_DOCS_PATH/#\~/$HOME}"
    if [ -d "$CUSTOM_DOCS_PATH" ]; then
        XCODE_DOCS_PATH="$CUSTOM_DOCS_PATH"
        print_success "Using provided docs path"
    else
        print_error "Docs path not found: $CUSTOM_DOCS_PATH"
        exit 1
    fi
elif [ -n "$CUSTOM_XCODE_PATH" ]; then
    CUSTOM_XCODE_PATH="${CUSTOM_XCODE_PATH/#\~/$HOME}"
    print_step "Checking custom Xcode path..."
    if [ ! -d "$CUSTOM_XCODE_PATH" ]; then
        print_error "Xcode not found at: $CUSTOM_XCODE_PATH"
        exit 1
    fi
    XCODE_DOCS_PATH=$(find_docs_in_xcode "$CUSTOM_XCODE_PATH") || true
    if [ -z "$XCODE_DOCS_PATH" ]; then
        print_error "AdditionalDocumentation not found in: $CUSTOM_XCODE_PATH"
        print_substep "Make sure you have Xcode 26 or later"
        exit 1
    fi
    print_success "Documentation found"
else
    print_step "Checking for Xcode..."
    print_line

    XCODE_LOCATIONS=(
        "/Applications/Xcode.app"
        "/Applications/Xcode-beta.app"
    )

    for xcode in "${XCODE_LOCATIONS[@]}"; do
        if [ -d "$xcode" ]; then
            XCODE_DOCS_PATH=$(find_docs_in_xcode "$xcode") || true
            if [ -n "$XCODE_DOCS_PATH" ]; then
                break
            fi
        fi
    done

    if [ -z "$XCODE_DOCS_PATH" ]; then
        print_step "Searching for AdditionalDocumentation..."
        XCODE_DOCS_PATH=$(find /Applications/Xcode*.app -name "AdditionalDocumentation" -type d 2>/dev/null | head -1) || true
    fi

    if [ -z "$XCODE_DOCS_PATH" ] || [ ! -d "$XCODE_DOCS_PATH" ]; then
        if [ ! -d "/Applications/Xcode.app" ] && [ ! -d "/Applications/Xcode-beta.app" ]; then
            print_error "Xcode not found"
            print_line
            print_substep "Please install Xcode from:"
            print_substep "- App Store: https://apps.apple.com/app/xcode/id497799835"
            print_substep "- Developer: https://developer.apple.com/xcode/"
            print_line
            print_substep "Or run with a custom path:"
            print_substep "$0 --xcode-path /path/to/Xcode.app"
            print_line
            exit 1
        fi

        prompt_for_path
    else
        XCODE_VERSION=$(/usr/bin/xcodebuild -version 2>/dev/null | head -1 | awk '{print $2}') || XCODE_VERSION="unknown"
        print_success "Found Xcode $XCODE_VERSION"
    fi
fi

print_line

# Extract documentation
print_step "Extracting documentation..."
mkdir -p "$DOCS_DIR"

doc_count=0
for doc in "$XCODE_DOCS_PATH"/*.md; do
    if [ -f "$doc" ]; then
        cp "$doc" "$DOCS_DIR/"
        ((doc_count++))
    fi
done

print_success "Extracted $doc_count files from Xcode"
print_line

# Create metadata
mkdir -p "$METADATA_DIR"
XCODE_VERSION=$(/usr/bin/xcodebuild -version 2>/dev/null | head -1 | awk '{print $2}') || XCODE_VERSION="unknown"
cat > "$METADATA_DIR/sources.json" << EOF
{
  "xcode_version": "$XCODE_VERSION",
  "extracted_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "docs_path": "$XCODE_DOCS_PATH",
  "doc_count": $doc_count
}
EOF

# Summary box
echo -e "◇  Setup Complete ──────────────────────────────────────────────────╮"
echo "│                                                                   │"
printf "│  ${GREEN}✓${NC} %-60s │\n" "Extracted $doc_count documentation files"
printf "│  ${GREEN}✓${NC} %-60s │\n" "Location: $DOCS_DIR"
echo "│                                                                   │"
echo "├───────────────────────────────────────────────────────────────────╯"
print_line
print_footer "Done! The skill is ready to use."
echo ""
