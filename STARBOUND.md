# Building the Bootloader and Firmware
1. requires `brew install sdcc` and `brew install srecord` as dependencies.
2. cd into the Firmware directory.
3. Run the command below:
`make clean; make install`
4. Now under Firmware/dst/ there are three files we care about:
    3.1 bootloader~hm_trp~915.hex ... the bootloader file that allows us to update through Mission Planner
    3.2 radio~hm_trp.ihx ... the firmware for the processor that we can update and change with the bootloader
    3.3 combined~915.hex ... the combined bootloader and firmware to make development easier

# Uploading the Bootloader and Firmware
1. cd into the Firmware directory
2. activate the python environment `source venv/bin/activate `
3. install dependencies `pip install pyserial`
4. figure out what port the usb is connected to with `python3 -m serial.tools.list_ports`
5. upload the firmware replacing the port `python3 tools/uploader.py --baudrate 115200 --port /dev/cu.usbserial-0001 dst/combined~915.hex`