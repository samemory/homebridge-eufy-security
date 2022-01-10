import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { EufySecurityPlatform } from '../platform';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { Station, DeviceType, PropertyName, PropertyValue, AlarmEvent } from 'eufy-security-client';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class StationAccessory {
  private service: Service;
  private alarm_triggered: boolean;

  protected characteristic;

  constructor(
    private readonly platform: EufySecurityPlatform,
    private readonly accessory: PlatformAccessory,
    private eufyStation: Station,
  ) {
    this.platform.log.debug(this.accessory.displayName, 'Constructed Station');
    // set accessory information

    this.characteristic = this.platform.Characteristic;

    this.alarm_triggered = false;

    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.characteristic.Manufacturer, 'Eufy')
      .setCharacteristic(
        this.characteristic.Model,
        eufyStation.getModel(),
      )
      .setCharacteristic(
        this.characteristic.SerialNumber,
        eufyStation.getSerial(),
      )
      .setCharacteristic(
        this.characteristic.FirmwareRevision,
        eufyStation.getSoftwareVersion(),
      );

    this.service =
      this.accessory.getService(this.platform.Service.SecuritySystem) ||
      this.accessory.addService(this.platform.Service.SecuritySystem);

    this.service.setCharacteristic(
      this.characteristic.Name,
      accessory.displayName,
    );

    // create handlers for required characteristics
    this.service
      .getCharacteristic(this.characteristic.SecuritySystemCurrentState)
      .onGet(this.handleSecuritySystemCurrentStateGet.bind(this));

    this.service
      .getCharacteristic(this.characteristic.SecuritySystemTargetState)
      .onGet(this.handleSecuritySystemTargetStateGet.bind(this))
      .onSet(this.handleSecuritySystemTargetStateSet.bind(this));

    this.eufyStation.on('guard mode', (station: Station, guardMode: number) =>
      this.onStationGuardModePushNotification(station, guardMode),
    );

    this.eufyStation.on('current mode', (station: Station, currentMode: number) =>
      this.onStationCurrentModePushNotification(station, currentMode),
    );

    this.eufyStation.on('alarm event', (station: Station, alarmEvent: AlarmEvent) =>
      this.onStationAlarmEventPushNotification(station, alarmEvent),
    );

    if (this.platform.config.enableDetailedLogging) {
      this.eufyStation.on('raw property changed', (device: Station, type: number, value: string, modified: number) =>
        this.handleRawPropertyChange(device, type, value, modified),
      );
      this.eufyStation.on('property changed', (device: Station, name: string, value: PropertyValue) =>
        this.handlePropertyChange(device, name, value),
      );
    }
  }

  private onStationGuardModePushNotification(
    station: Station,
    guardMode: number,
  ): void {
    this.platform.log.debug(this.accessory.displayName, 'ON SecurityGuardMode:', guardMode);
    const homekitCurrentMode = this.convertEufytoHK(guardMode);

    // fullphat: also both SecuritySystemCurrentState to avoid HomeKit getting stuck 'Arming...' or 'Disarming...'
    if (this.isFloodlightCamera) {
      this.service
        .getCharacteristic(this.characteristic.SecuritySystemCurrentState)
        .updateValue(homekitCurrentMode);
      }

    this.service
      .getCharacteristic(this.characteristic.SecuritySystemTargetState)
      .updateValue(homekitCurrentMode);

  }

  private onStationCurrentModePushNotification(
    station: Station,
    currentMode: number,
  ): void {
    this.platform.log.debug(this.accessory.displayName, 'ON SecuritySystemCurrentState:', currentMode);

    // fullphat: only process this if the station is *not* a T8420 camera...
    if (!this.isFloodlightCamera) {
      const homekitCurrentMode = this.convertEufytoHK(currentMode);
      this.platform.log.info('SecuritySystemCurrentState translated to HomeKit mode:', homekitCurrentMode);
      this.service
          .getCharacteristic(this.characteristic.SecuritySystemCurrentState)
          .updateValue(homekitCurrentMode);
    }
    else {
      this.platform.log.info('ignoring (station is a T8420 camera)');
    }

  }

  private onStationAlarmEventPushNotification(
    station: Station,
    alarmEvent: AlarmEvent,
  ): void {
    switch (alarmEvent) {
      case 2: // Alarm triggered by GSENSOR
      case 3: // Alarm triggered by PIR
      case 6: // Alarm triggered by DOOR
      case 7: // Alarm triggered by CAMERA_PIR
      case 8: // Alarm triggered by MOTION_SENSOR
      case 9: // Alarm triggered by CAMERA_GSENSOR
        this.platform.log.warn('ON StationAlarmEvent - ALARM TRIGGERED - alarmEvent:', alarmEvent);
        this.alarm_triggered = true;
        this.service
          .getCharacteristic(this.characteristic.SecuritySystemCurrentState)
          .updateValue(this.characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED); // Alarm !!!
        break;
      case 15: // Alarm off by Keypad
      case 16: // Alarm off by Eufy App
      case 17: // Alarm off by HomeBase button
        this.platform.log.warn('ON StationAlarmEvent - ALARM OFF - alarmEvent:', alarmEvent);
        this.alarm_triggered = false;
        break;
      default:
        this.platform.log.warn('ON StationAlarmEvent - ALARM UNKNOWN - alarmEvent:', alarmEvent);
        this.service
          .getCharacteristic(this.characteristic.StatusFault)
          .updateValue(this.characteristic.StatusFault.GENERAL_FAULT);
        break;
    }
  }

  mappingHKEufy() {
    const modes = [
      { hk: 0, eufy: this.platform.config.hkHome ?? 1 },
      { hk: 1, eufy: this.platform.config.hkAway ?? 0 },
      { hk: 2, eufy: this.platform.config.hkNight ?? 3 }
    ];

    // If keypad attached to the station
    if (this.eufyStation.hasDeviceWithType(DeviceType.KEYPAD)) {
      modes.push({ hk: 3, eufy: this.platform.config.hkOff ?? 63 });
      modes.push({ hk: 3, eufy: ((modes.filter((m) => { return m.eufy === 6; })[0]) ? 63 : 6) });
    } else {
      modes.push({ hk: 3, eufy: (this.platform.config.hkOff == 6) ? 63 : this.platform.config.hkOff }); // Enforce 63 if keypad has been selected but not attached to the station
    }

    return modes;
  }

  convertHKtoEufy(hkMode) {
    const modeObj = this.mappingHKEufy().filter((m) => { return m.hk === hkMode; });
    return modeObj[0] ? modeObj[0].eufy : hkMode;
  }

  convertEufytoHK(eufyMode) {
    const modeObj = this.mappingHKEufy().filter((m) => { return m.eufy === eufyMode; });
    return modeObj[0] ? modeObj[0].hk : eufyMode;
  }


  // fullphat: simple helper function that determines if this is a Floodlight Camera (T8420) or note
  // can be replaced with something more suitable
  isFloodlightCamera() {
    const isFloodlightCam = this.eufyStation.getModel() == "T8420";
    // this.platform.log.info('isFloodlightCamera:', this.eufyStation.getModel(), isFloodlightCam);
    return isFloodlightCam;
  }



  /**
   * Handle requests to get the current value of the 'Security System Current State' characteristic
   */
  async handleSecuritySystemCurrentStateGet(): Promise<CharacteristicValue> {
    if (this.alarm_triggered) {
      return this.characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED;
    }
    try {

      // fullphat: use StationCurrentMode rather than StationGuardMode here as the latter is more reliable
      // (StationCurrentMode often returns -1 as the value and 0 as the timestamp)
      // const currentValue = this.eufyStation.getPropertyValue(eufy_security_client_1.PropertyName.StationGuardMode);
      var propertyToUse = eufy_security_client_1.PropertyName.StationCurrentMode;
      if (this.isFloodlightCamera()) {
        this.platform.log.info(this.accessory.displayName, 'station is a floodlight camera so using GuardMode property instead');
        propertyToUse = eufy_security_client_1.PropertyName.StationGuardMode
      }

      // fullphat: now read the correct property value
      const currentValue = this.eufyStation.getPropertyValue(propertyToUse);
      this.platform.log.info(this.accessory.displayName, 'GET StationGuardMode:', currentValue);

      // fullphat: this shouldn't happen, but just in case...
      const hkValue = this.convertEufytoHK(currentValue.value)
      if (hkValue == -1) {
        this.platform.log.warn('handleSecuritySystemCurrentStateGet: WARNING: converting invalid value', hkValue, 'to 1');
        hkValue = 1;
      }
      return hkValue;
      
    }
  }

  /**
   * Handle requests to get the current value of the 'Security System Target State' characteristic
   */
  handleSecuritySystemTargetStateGet(): CharacteristicValue {
    try {
      const currentValue = this.eufyStation.getPropertyValue(PropertyName.StationGuardMode);
      this.platform.log.debug(this.accessory.displayName, 'GET StationGuardMode:', currentValue);
      return this.convertEufytoHK(currentValue.value) as number;
    } catch {
      this.platform.log.error(this.accessory.displayName, 'handleSecuritySystemTargetStateGet', 'Wrong return value');
      return false;
    }
  }

  /**
   * Handle requests to set the 'Security System Target State' characteristic
   */
  handleSecuritySystemTargetStateSet(value: CharacteristicValue) {
    try {
      const mode = this.convertHKtoEufy(value as number);
      this.platform.log.debug(this.accessory.displayName, 'SET StationGuardMode:', mode);
      this.eufyStation.setGuardMode(mode);
    } catch (error) {
      this.platform.log.error('Error Setting security mode!', error);
    }
  }

  private handleRawPropertyChange(
    device: Station,
    type: number,
    value: string,
    modified: number,
  ): void {
    this.platform.log.debug(this.accessory.displayName,
      'ON handleRawPropertyChange:',
      {
        type,
        value,
        modified,
      },
    );
  }

  private handlePropertyChange(
    device: Station,
    name: string,
    value: PropertyValue,
  ): void {
    this.platform.log.debug(this.accessory.displayName,
      'ON handlePropertyChange:',
      {
        name,
        value,
      },
    );
  }
}
