// Held-out semantic evaluation set (synthetic). Written to be HARD for the offline concept-based embedding: the paraphrases deliberately avoid
// the words in the fixes' own text and in the offline concept list. Each fix names an environment so compatibility matters.
//   positives   : a customer paraphrase of one fix, on a compatible device -> the fix should be recommended
//   incompatible: the same problem on a device/version the fix does not support -> nothing should be recommended
//   safety      : the same problem, but the customer reports a condition the fix forbids -> nothing should be recommended
//   unrelated   : a problem none of the fixes covers -> nothing should be recommended
export const FIXES = [
  { id: 'display', title: 'Screen flicker after startup', symptoms: 'The display flickers right after the laptop starts', steps: 'Open Display settings, set Refresh Mode to Fixed 60 Hz and restart.', env: 'Model X firmware 4' },
  { id: 'wifi', title: 'Wi-Fi keeps disconnecting', symptoms: 'Wireless connection drops every few minutes', steps: 'Forget the network, restart the router link and install wireless driver 2.1.', env: 'Model X firmware 4' },
  { id: 'battery', title: 'Battery drains very fast', symptoms: 'Battery percentage falls quickly even when idle', steps: 'Switch the power profile to Balanced and close background sync apps.', env: 'Model X firmware 4', restriction: 'Do not use if the battery is swollen' },
  { id: 'login', title: 'Sign-in refused after update', symptoms: 'Correct password is rejected after the latest update', steps: 'Clear saved credentials in the account manager and sign in again.', env: 'Model X firmware 4' },
  { id: 'audio', title: 'No sound from speakers', symptoms: 'Speakers produce no audio after waking from sleep', steps: 'Select the correct output device and restart the audio service.', env: 'Model X firmware 4' },
  { id: 'camera', title: 'Camera shows black picture', symptoms: 'Video calls show a black image from the webcam', steps: 'Allow camera access in Privacy settings and reinstall the camera driver.', env: 'Model X firmware 4' },
  { id: 'disk', title: 'Disk is full', symptoms: 'Saving files fails because storage is used up', steps: 'Run Storage cleanup and move large files to an external drive.', env: 'Model X firmware 4' },
  { id: 'mail', title: 'Email stops syncing', symptoms: 'New messages do not arrive in the inbox', steps: 'Remove and re-add the mail account, then force a full sync.', env: 'Model X firmware 4' },
  { id: 'crash', title: 'App closes on launch', symptoms: 'The application quits immediately when opened', steps: 'Reset the application settings and reinstall the latest version.', env: 'Model X firmware 4' },
  { id: 'jam', title: 'Printer paper jam', symptoms: 'The printer reports a jam but no paper is visible', steps: 'Open the rear tray, clean the paper sensor with a dry cloth and restart.', env: 'Model X firmware 4' },
  { id: 'bluetooth', title: 'Bluetooth headset will not pair', symptoms: 'The headset is found but pairing never completes', steps: 'Remove the device, reset its pairing mode and pair again.', env: 'Model X firmware 4' },
  { id: 'fan', title: 'Fan is loud and the laptop is hot', symptoms: 'The fan runs at full speed and the case gets hot', steps: 'Clean the vents with compressed air and update the thermal firmware.', env: 'Model X firmware 4', restriction: 'Do not use if the device is wet' },
  { id: 'keyboard', title: 'Keys type the wrong characters', symptoms: 'Typing produces different letters than the keys show', steps: 'Change the keyboard layout back to the correct language in Settings.', env: 'Model X firmware 4' },
  { id: 'vpn', title: 'VPN will not connect', symptoms: 'The secure tunnel to the office fails to establish', steps: 'Reinstall the approved VPN client and re-import the profile.', env: 'Model X firmware 4' },
  { id: 'update', title: 'System update stuck', symptoms: 'The update progress bar has not moved for hours', steps: 'Stop the update service, clear the update cache and run the update again.', env: 'Model X firmware 4' },
  { id: 'touch', title: 'Touchpad does not respond', symptoms: 'The cursor does not move when using the trackpad', steps: 'Re-enable the touchpad in Settings and reinstall the pointing device driver.', env: 'Model X firmware 4' },
];
// Paraphrases avoid the fix text and the offline concept words.
export const PARAPHRASES = {
  display: ['My picture jumps and tears for a few seconds whenever I power the machine up', 'Right after I turn the notebook on the image wobbles and strobes'],
  wifi: ['The internet link keeps cutting out and coming back all afternoon', 'I lose my connection to the router about every five minutes'],
  battery: ['The charge level plunges even though I am not doing anything', 'My power runs out within an hour of unplugging it'],
  login: ['It says my password is wrong but I am certain it is right since the upgrade', 'After installing the newest version I cannot get into my account'],
  audio: ['Nothing comes out of the built-in speakers when I open the lid again', 'It is completely quiet after the computer resumes'],
  camera: ['People on video meetings only see a dark rectangle instead of me', 'The built-in lens gives me nothing but darkness in calls'],
  disk: ['Every attempt to save a document complains there is no room left', 'The machine says I have run out of space whenever I store anything'],
  mail: ['No fresh mail shows up for me anymore unless I reinstall everything', 'My messages stopped arriving and the folder never refreshes'],
  crash: ['The program disappears the instant I double click it', 'As soon as I start the software it shuts itself down'],
  jam: ['It insists something is stuck inside but the tray is clear', 'The device complains about a blockage although I see no sheet'],
  bluetooth: ['My earphones show up in the list yet never finish connecting', 'I can see the wireless buds but they refuse to link up'],
  fan: ['The cooler screams constantly and the bottom of the machine burns my knees', 'It is very noisy and uncomfortably warm to touch'],
  keyboard: ['When I press an a I get a q and the punctuation is all shuffled', 'The letters that appear do not match the ones I press'],
  vpn: ['I cannot reach the company network from home, the remote tunnel will not come up', 'Connecting securely to work always errors out'],
  update: ['The installer bar has been frozen at the same spot since this morning', 'My patching process seems to hang forever'],
  touch: ['Moving my finger across the pad does nothing to the pointer', 'The mouse arrow ignores the built-in pad'],
};
export const INCOMPATIBLE = [
  ['display', 'My picture jumps and tears whenever I power the machine up. Model X firmware 5.'],
  ['wifi', 'The internet link keeps cutting out all afternoon. Model Y firmware 4.'],
  ['audio', 'Nothing comes out of the speakers after I resume. Model X firmware 2.'],
  ['mail', 'No fresh mail arrives for me anymore. Model Z firmware 9.'],
  ['vpn', 'I cannot reach the company network from home. Model Q firmware 4.'],
  ['keyboard', 'Letters that appear do not match the keys I press. Model X firmware 7.'],
  ['crash', 'The program disappears the instant I open it. Model W firmware 4.'],
  ['disk', 'Saving complains there is no room left. Model X firmware 12.'],
];
export const SAFETY = [
  ['battery', 'The charge level plunges even though I am idle, and the battery looks swollen and puffy.'],
  ['battery', 'My power runs out within an hour and the pack is visibly bulging. Model X firmware 4.'],
  ['fan', 'The cooler screams and it is very hot, and the laptop got wet from a spill earlier. Model X firmware 4.'],
  ['fan', 'It is loud and burning hot after I spilled water on it. Model X firmware 4.'],
];
export const UNRELATED = [
  'How do I change the billing address on my invoice? Model X firmware 4.',
  'Can I book an appointment for next Tuesday afternoon? Model X firmware 4.',
  'What are your opening hours at the service centre? Model X firmware 4.',
  'I would like to cancel my subscription. Model X firmware 4.',
  'Where can I download the user manual in French? Model X firmware 4.',
  'Is there a student discount for the extended warranty? Model X firmware 4.',
];
