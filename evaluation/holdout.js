import { cases } from './cases.js';

// Held-out paraphrases, written independently of the regression and challenge sets
// and BEFORE the retrieval-strengthening work that is measured against them. They
// are not used to tune concepts, thresholds or prompts. Synthetic, not real customer data.
const questions = {
  display: [
    'The laptop screen shimmers and strobes for a minute whenever I power it on.',
    'Right after I switch the machine on, the visuals on the panel pulse unsteadily.',
    'There is an unsteady, jittery glow on the display at boot time.',
  ],
  wireless: [
    'Our office wifi cuts out every few minutes and the laptop has to rejoin.',
    'I lose the wireless link intermittently and then must connect again manually.',
    'Browsing keeps getting interrupted because the network connection keeps vanishing.',
  ],
  battery: [
    'Power runs down way faster than normal, even with nothing open.',
    'Unplugged, my laptop loses its charge in under an hour while idle.',
    'The remaining energy indicator plummets for no obvious reason.',
  ],
  printer: [
    'The office printer complains about a stuck sheet and refuses to continue.',
    'A page got caught inside the printer and now every job halts.',
    'Paper keeps getting jammed in the printer rollers.',
  ],
  vpn: [
    'My login is refused whenever I try to connect to the company VPN.',
    'The VPN client rejects my credentials at the sign-in step.',
    'I cannot authenticate to the corporate tunnel; it declines my sign in.',
  ],
  audio: [
    'Nothing comes out of the laptop speakers when I play music.',
    'The built-in audio is silent during videos and calls.',
    'I hear no sound at all from the computer.',
  ],
  camera: [
    'When I open the webcam all I get is a dark empty square.',
    'The video call camera shows only black, no image at all.',
    'My laptop camera preview is completely blank.',
  ],
  storage: [
    'The drive is out of space and I cannot store more documents.',
    'My computer says the disk has no available room left.',
    'There is no free capacity on the storage so saving fails.',
  ],
  email: [
    'Fresh messages never arrive in my mailbox; the inbox is stuck.',
    'My email client is not syncing and shows old messages only.',
    'The mail app stopped refreshing the inbox.',
  ],
  application: [
    'The software shuts down by itself right after it opens.',
    'Whenever I start the app it crashes straight away.',
    'The application terminates unexpectedly seconds after launching.',
  ],
};
export const holdoutCases = cases.map((c) => ({ ...c, queries: questions[c.id] }));
