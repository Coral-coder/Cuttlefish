# Compatibility reference

## Lighting effects (LightScripts)

| API | Status |
|---|---|
| 320×200 page captured each frame (any canvas id, WebGL included) | ✅ |
| `<title>`, `<meta description>`, `<meta publisher>` | ✅ |
| `<meta property type=number/hue/boolean/color/textfield/list/combobox>` → globals | ✅ booleans are `0/1`, numbers are numbers |
| `on<property>Changed()` callbacks | ✅ |
| `engine.audio.level` (−100…0 dB), `.density`, `.width`, `.freq[200]` | ✅ Windows loopback capture |
| `engine.zone.hue/saturation/lightness[560]` | ✅ when screen capture is enabled |
| `<meta meter type=linear/area>` → `engine.vision.<name>` | ✅ |
| `<meta meter type=ocr_textmatch/ocr_numeric>` | ❌ always `-1` |
| `<resolution>` meter overrides | ❌ the default meter is used |

## Device plugins

Tested by loading all 466 public plugins (462 parse; 390/437 HID plugins initialise and render against a simulated device that answers every read with zeros. The rest wait for real device replies, as expected).

| API | Status |
|---|---|
| Exports: `Name VendorId ProductId Publisher Documentation Size Type DefaultPosition DefaultScale LedNames LedPositions ControllableParameters Validate Scan Initialize Render Shutdown ImageUrl DeviceMessage SupportsSubdevices` | ✅ |
| `device.write/read/send_report/get_report/getLastReadSize/clearReadBuffer/set_endpoint/flush/pause/log` | ✅ (node-hid, synchronous) |
| `device.color`, `getBrightness`, `createColorArray` (Inline/Separate, colour orders) | ✅ |
| `setName/setSize/setControllableLeds/setImageFrom*` | ✅ |
| Subdevices (`createSubdevice`, `setSubdeviceLeds`, `subdeviceColor`, …) | ✅ each subdevice is a layout item |
| Component channels (`addChannel`, `channel(id).getColors/LedCount/shouldPulseColors/getPulse`) | ✅ LED count set per channel on the Devices page |
| `notify/denotify/addMessage/removeMessage`, `addProperty/getProperty/removeProperty` | ✅ |
| Features: `battery`, `base64`, `keyboard`, `mouse` (events ignored) | ✅ / partial |
| `bus` (FixedAddressBus) / `Scan(bus)` (FreeAddressBus) on Intel/AMD system SMBus | ✅ via PawnIO; opt-in for third-party plugins |
| Fan control / temperature sensors | ❌ stubs (`fanControlDisabled() === true`) |
| `RAWUSB` (libusb bulk/control transfers), network `service`/UDP/Hue/Nanoleaf plugins | ❌ not yet |
| GPU (NVAPI/ADL) I²C buses | ❌ not yet (use the OpenRGB bridge) |

Plugin load order matches SignalRGB: downloaded library → SignalRGB install → `Documents\WhirlwindFX\Plugins` → Cuttlefish user plugins → extra folders. For the same VID/PID, later folders override earlier ones.

Each plugin call runs under a watchdog (3 s for `Render`, 15 s for `Initialize`), so a plugin stuck in a loop can't freeze lighting.
