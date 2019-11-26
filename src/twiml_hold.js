/**************************************************************************************

    Aria Hold action
    
    Hold the active call leg.

**************************************************************************************/
twimlActions.Hold = (command, callback) => {

  var call = command.call;
  var channel = call.channel;
  var client = call.client;
  var playback = null;
  var bridge = null;
  
  console.log("Channel " + channel.id + " - Hold");

  // find or create a holding bridge
  
  client.bridges.list((err, bridges) => {
    if (err) {
      throw err;
    }

    bridge = bridges.filter(candidate => candidate.bridge_type === 'holding')[0];

    if (bridge) {
      console.log(util.format('Using bridge %s', bridge.id));
      start();
    } else {
      client.bridges.create({type: 'holding'}, (err, newBridge) => {
        if (err) {
          throw err;
        }
        bridge = newBridge;
        console.log(util.format('Created bridge %s', bridge.id));
        start();
      });
    }
  });

  // continue the call on the next tick
  var start = () => {
    setTimeout(() => {
      bridge.addChannel({channel: channel.id}, err => {
        if (err) {
          throw err;
        }

        bridge.startMoh(err => {
          if (err) {
            throw err;
          }
          return callback();
        });
      });
    }, 0);
  }
};


