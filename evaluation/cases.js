// Fixed synthetic fixtures. Query wording is kept separate from source symptoms.
export const cases = [
  {
    id: 'display',
    title: 'Display flicker',
    symptoms: 'Display flickers after startup',
    environment: 'Model X firmware 4',
    solution: 'Disable Adaptive Refresh in Display Settings, then install the approved display driver 4.2.',
    queries: [
      'The monitor flashes when booting the notebook.',
      'My screen blinks after startup. What can I do?',
    ],
  },
  {
    id: 'wireless',
    title: 'Wireless disconnect',
    symptoms: 'Wi-Fi disconnects repeatedly',
    environment: 'Model R firmware 2',
    solution:
      'Remove the stale saved network profile, then reconnect using the company-provided wireless profile.',
    queries: [
      'The wireless connection keeps dropping repeatedly.',
      'Internet disconnects repeatedly during work.',
    ],
  },
  {
    id: 'battery',
    title: 'Battery drain',
    symptoms: 'Battery drains rapidly',
    environment: 'Model B firmware 3',
    solution:
      'Disable background device discovery in the approved power profile and apply the verified battery controller update.',
    queries: ['The charge is depleting rapidly.', 'My battery keeps discharging rapidly even while idle.'],
  },
  {
    id: 'printer',
    title: 'Paper jam',
    symptoms: 'Printer paper jam',
    environment: 'Model P firmware 6',
    solution:
      'Remove the folded sheet from the rear paper guide, then reload flat paper within the marked tray limit.',
    queries: ['The printer reports a paper jam.', 'Paper is stuck inside my printer.'],
  },
  {
    id: 'vpn',
    title: 'VPN authentication',
    symptoms: 'VPN login rejected',
    environment: 'Windows 11',
    solution:
      'Remove the expired VPN certificate and import the replacement certificate issued by the company support team.',
    queries: ['VPN sign-in is rejected.', 'The VPN refuses my login.'],
  },
  {
    id: 'audio',
    title: 'Silent audio',
    symptoms: 'Audio output silent',
    environment: 'Model A firmware 2',
    solution:
      'Select the internal audio output in the approved audio utility and disable the disconnected docking-station output.',
    queries: ['Sound output is muted.', 'The speakers are silent.'],
  },
  {
    id: 'camera',
    title: 'Camera preview',
    symptoms: 'Webcam preview black',
    environment: 'Model C firmware 3',
    solution:
      'Open the physical camera privacy shutter and reselect the internal camera in the meeting application.',
    queries: ['The camera preview is blank.', 'My webcam shows a black preview.'],
  },
  {
    id: 'storage',
    title: 'Storage capacity',
    symptoms: 'Disk storage full',
    environment: 'Windows 10',
    solution:
      'Use the built-in Storage settings to remove temporary update files, preserving personal files and installed applications.',
    queries: ['The drive is out of space.', 'Storage reports no free space.'],
  },
  {
    id: 'email',
    title: 'Email synchronization',
    symptoms: 'Email messages not syncing',
    environment: 'Model M firmware 5',
    solution:
      'Resume synchronization for the affected mailbox and replace its expired sign-in session using the approved account flow.',
    queries: ['Mail messages are not synchronizing.', 'My email has stopped syncing messages.'],
  },
  {
    id: 'application',
    title: 'Application crash',
    symptoms: 'Application crashes when opening',
    environment: 'Model K firmware 7',
    solution:
      'Disable the incompatible reporting extension and reopen the application with the verified extension profile.',
    queries: ['The app crashes when I open it.', 'The application closes unexpectedly on launch.'],
  },
];
