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

# Uploading Code using SI Labs Debug Adapter
1. Need to install the ec2tools https://github.com/tridge/ec2
2. For 433 `ec2writeflash --port=USB --mode=c2 --eraseall --run --hex Firmware/dst/combined~433.hex`
3. For 915 `ec2writeflash --port=USB --mode=c2 --eraseall --run --hex Firmware/dst/combined~915.hex`

# All in One Command to generate the firmware and then upload it to the cloud.
```
cd Firmware ; make clean ; make install ; cd .. ; darwincli firmware upload 4 Firmware/dst/combined~915.hex "915 version of radio software" ; darwincli firmware upload 8 Firmware/dst/combined~433.hex "433 version of radio software" ;
```