#
# Copyright (c) 2011 Michael Smith, All Rights Reserved
#
# Redistribution and use in source and binary forms, with or without
# modification, are permitted provided that the following conditions
# are met:
#
#  o Redistributions of source code must retain the above copyright 
#    notice, this list of conditions and the following disclaimer.
#  o Redistributions in binary form must reproduce the above copyright 
#    notice, this list of conditions and the following disclaimer in 
#    the documentation and/or other materials provided with the distribution.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
# "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
# LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS
# FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
# COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
# INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
# (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
# SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
# HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
# STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
# ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED
# OF THE POSSIBILITY OF SUCH DAMAGE.
#

#
# Makefile for the SiK radio firmware.
#

################################################################################
# No user-serviceable parts below
################################################################################

#
# Generic actions (targets) that the user may invoke.
#
ACTIONS		 = build clean install

#
# Locate the root of the firmware source tree
#
export SRCROOT	 = $(dir $(lastword $(MAKEFILE_LIST)))

#
# Work out which board(s) we know how to support
#
KNOWN_BOARDS	 = $(patsubst rules_%.mk,%,$(notdir $(wildcard $(SRCROOT)/include/rules_*.mk)))

#
# Allow the user to subset the boards for which we will build.
#
BOARDS		?= $(KNOWN_BOARDS)
ifneq ($(filter_out $(VALID_BOARDS),$(BOARDS)),)
$(error One or more invalid board names in '$(BOARDS)'.)
endif

#
# Make lists of the buildable things
#
# XXX radio should become firmware? 
#
BOOTLOADERS	 = $(foreach board, $(BOARDS), bootloader~$(board))
FIRMWARES	 = $(foreach board, $(BOARDS), radio~$(board))
PRODUCTS	 = $(BOOTLOADERS) $(FIRMWARES)

#
# Build a full list of the things that may be built.
#
TARGETS		 = $(foreach action,$(ACTIONS), \
			$(foreach product,$(PRODUCTS), \
				$(action)~$(product)))

all:		build

#
# Composite targets for handling actions.
#
build:		$(filter build~%,$(TARGETS))
install:
	@$(MAKE) $(filter install~%,$(TARGETS))
	@echo "Normalizing bootloader hex files..."
	srec_cat -disable-sequence-warning dst/bootloader~hm_trp~915.hex -Intel -o dst/bootloader~hm_trp~915.hex -Intel
	srec_cat -disable-sequence-warning dst/bootloader~hm_trp~433.hex -Intel -o dst/bootloader~hm_trp~433.hex -Intel
	@echo "Combining bootloader and radio firmware into a single hex file..."
	srec_cat -disable-sequence-warning dst/bootloader~hm_trp~915.hex -Intel dst/radio~hm_trp.ihx -Intel -o dst/combined~915.hex -Intel
	srec_info dst/combined~915.hex -Intel
	srec_cat -disable-sequence-warning dst/bootloader~hm_trp~433.hex -Intel dst/radio~hm_trp.ihx -Intel -o dst/combined~433.hex -Intel
	srec_info dst/combined~433.hex -Intel
	@echo "Building Spectra firmware variants..."
	@mkdir -p obj/spectra
	@$(MAKE) -f radio/product.mk build BOARD=hm_trp OBJROOT=obj/spectra/915_broadcast CFLAGS_VARIANT="-DPARAM_FORMAT_VARIANT=0x1cUL -DDEFAULT_DUTY_CYCLE=100 -DDEFAULT_MIN_FREQ_KHZ=915000UL -DDEFAULT_MAX_FREQ_KHZ=928000UL"
	@cp obj/spectra/915_broadcast/radio~hm_trp.ihx dst/spectra~915~broadcast.ihx
	@srec_cat -disable-sequence-warning dst/bootloader~hm_trp~915.hex -Intel dst/spectra~915~broadcast.ihx -Intel -o dst/spectra~915~broadcast.hex -Intel
	@$(MAKE) -f radio/product.mk build BOARD=hm_trp OBJROOT=obj/spectra/915_receiver CFLAGS_VARIANT="-DPARAM_FORMAT_VARIANT=0x1dUL -DDEFAULT_DUTY_CYCLE=0 -DDEFAULT_MIN_FREQ_KHZ=915000UL -DDEFAULT_MAX_FREQ_KHZ=928000UL"
	@cp obj/spectra/915_receiver/radio~hm_trp.ihx dst/spectra~915~receiver.ihx
	@srec_cat -disable-sequence-warning dst/bootloader~hm_trp~915.hex -Intel dst/spectra~915~receiver.ihx -Intel -o dst/spectra~915~receiver.hex -Intel
	@$(MAKE) -f radio/product.mk build BOARD=hm_trp OBJROOT=obj/spectra/433_broadcast CFLAGS_VARIANT="-DPARAM_FORMAT_VARIANT=0x1eUL -DDEFAULT_DUTY_CYCLE=100 -DDEFAULT_MIN_FREQ_KHZ=433050UL -DDEFAULT_MAX_FREQ_KHZ=434790UL"
	@cp obj/spectra/433_broadcast/radio~hm_trp.ihx dst/spectra~433~broadcast.ihx
	@srec_cat -disable-sequence-warning dst/bootloader~hm_trp~433.hex -Intel dst/spectra~433~broadcast.ihx -Intel -o dst/spectra~433~broadcast.hex -Intel
	@$(MAKE) -f radio/product.mk build BOARD=hm_trp OBJROOT=obj/spectra/433_receiver CFLAGS_VARIANT="-DPARAM_FORMAT_VARIANT=0x1fUL -DDEFAULT_DUTY_CYCLE=0 -DDEFAULT_MIN_FREQ_KHZ=433050UL -DDEFAULT_MAX_FREQ_KHZ=434790UL"
	@cp obj/spectra/433_receiver/radio~hm_trp.ihx dst/spectra~433~receiver.ihx
	@srec_cat -disable-sequence-warning dst/bootloader~hm_trp~433.hex -Intel dst/spectra~433~receiver.ihx -Intel -o dst/spectra~433~receiver.hex -Intel
	@echo "Spectra firmware variants generated successfully"
clean:
	@echo "Removing entire build directory..."
	rm -rf obj/
	rm -rf dst/
	@$(MAKE) $(filter clean~%,$(TARGETS))


#
# Composite target for handling the generic actions for each possible combination
# of action and configuration.
#
$(TARGETS):	config    = $(subst ~, ,$@)
$(TARGETS):	action    = $(word 1, $(config))
$(TARGETS):	product   = $(word 2, $(config))
$(TARGETS):	board     = $(word 3, $(config))
$(TARGETS):
	@echo % $(action) $(product) for $(board)
	@make -f $(product)/product.mk $(action) \
		BOARD=$(board)

.PHONY:	$(ACTIONS) $(TARGETS)

help:
	@echo ""
	@echo "Build bootloaders and firmware for Si1000 radio boards."
	@echo ""
	@echo "Common targets are:"
	@echo ""
	@echo "    all         - Builds bootloaders and firmware, this is the"
	@echo "                  default target."
	@echo "    bootloader  - Builds the bootloader(s) specified"
	@echo "    firmware    - Builds the firmware(s) specified"
	@echo "    clean       - Cleans all build products"
	@echo ""
	@echo "A specific product may be built by selecting one or more of the following targets:"
	@echo ""
	@for i in $(TARGETS); do echo "    $$i"; done
	@echo ""
	@echo "Variables may be set to control what is built:"
	@echo ""
	@echo "    BOARDS      - One or more board names from the list:"
	@echo "                    $(BOARDS)"
	@echo ""
	@echo "The following maintenance targets are mostly of interest to"
	@echo "developers:"
	@echo ""
	@echo "    format      - Automatically (re)formats source code to conform"
	@echo "                  to the SiK coding style.  Should be used before"
	@echo "                  checking in or submitting a patch."
	@echo ""


.PHONY:	format
format:
	astyle -r $(FMT) "*.c" "*.h"
#
# Below are options passed to Artistic Style for the format target
#

# Basic style is what AS calls K&R
FMT		+= --style=kr

# Indent using 8-space tabs
FMT		+= --indent=tab=8

# Indent multiline preprocessor blocks
FMT		+= --indent-preprocessor

# Do smart multiline expression indentation
FMT		+= --min-conditional-indent=0

# Pad conditionals and else blocks
# Not sure about this one yet
#FMT		+= --break-blocks=all

# Add space padding around operators
FMT		+= --pad-oper

# Add space padding after paren headers
FMT		+= --pad-header

# Clean up excess paren padding
FMT		+= --unpad-paren

# Avoid breaking up 'clever' formatting
FMT		+= --keep-one-line-blocks
FMT		+= --keep-one-line-statements

# * belongs with the name (looks good, but syntactically bad)
FMT		+= --align-pointer=name

# force *nix line endings
FMT		+= --lineend=linux

# ignore various things that should be ignored
FMT		+= --ignore-exclude-errors-x
FMT		+= --exclude=obj

# ignore various files we want to be able to diff with upstream providers
FMT		+= --exclude=Si1000_defs.h
FMT		+= --exclude=Si1020_defs.h
FMT		+= --exclude=compiler_defs.h
FMT		+= --exclude=rtPhy.c
FMT		+= --exclude=rtPhy.h
FMT		+= --exclude=rtPhy_defs.h
FMT		+= --exclude=printfl.c
