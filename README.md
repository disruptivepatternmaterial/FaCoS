# FaCoS
Fake ESU ECoS using Node-Red to Integrate with iTrain or JMRI

What would you want this? Well the makers of iTrain refuse to put an MQTT interface or some other open interface into the application. JMRI has, but you know, I've been writting and using software for 40 years and was not able to get JMRI working, whereas iTrain I had working in a few hours.

You know YMMV...

Add this to your node-red

Create a new interface in iTrain to the ip/port you config

Make it ONLY acessories (I have the rest sort of working)

Make something with a particular ID, and then you will see that number read r or g in MQTT

You can then link that up to whatever you want to control. In my case this is custom lighting.

