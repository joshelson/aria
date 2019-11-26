/**************************************************************************************

    Aria Bridge action
    
    Bridge two legs together in a call. Assumes that there are valid values for
    call.originatingChannel and call.dialedChannel.

**************************************************************************************/
twimlActions.Bridge = (command, callback) => {

  var call = command.call;
  var client = call.client;
  
  console.log("Channel " + call.originatingChannel.id + " - Bridge");

  // handler for original channel hanging. gracefully hangup the dialed channel
  var hangupDialed = (channel, dialed) => {
    console.log(
      "Channel %s - Channel has left the application. Hanging up dialed channel %s",
      channel.id, dialed.id);

    // hangup the other end
    dialed.hangup(err => {
      // ignore error since dialed channel could have hung up, causing the
      // original channel to exit Stasis
    });
  };

  // handler for dialed channel hanging up.
  var hangupOriginal = (channel, dialed) => {
    console.log(
      "Channel %s - Dialed channel %s has been hung up.",
      channel.id, dialed.id);

    // hangup the original channel
    channel.hangup(err => {
      // ignore error since original channel could have hung up, causing the
      // dialed channel to exit Stasis
    });
  };

  // handler for dialed channel entering Stasis
  var joinMixingBridge = (channel, dialed) => {
    var bridge = client.Bridge();

    dialed.on("StasisEnd", (event, dialed) => {
      dialedExit(dialed, bridge);
    });

    dialed.answer(err => {
      if (err) {
        throw err; // TODO: trap and handle this.
      }
      console.log(
        "Channel %s - Dialed channel %s has been answered.",
        channel.id, dialed.id);
    });

    bridge.create({
      type: "mixing"
    }, (err, bridge) => {
      if (err) {
        throw err; // TODO: trap and handle this.
      }

      console.log("Channel %s - Created bridge %s", channel.id, bridge.id);

      addChannelsToBridge(channel, dialed, bridge);
    });
  };

  // handler for the dialed channel leaving Stasis
  var dialedExit = (dialed, bridge) => {
    console.log(
      "Channel %s - Dialed channel %s has left our application, destroying bridge %s",
      call.channel.id, dialed.name, bridge.id);

    bridge.destroy(err => {
      if (err) {
        throw err;
      }
    });
  };

  // handler for new mixing bridge ready for channels to be added to it
  var addChannelsToBridge = (channel, dialed, bridge) => {
    console.log("Channel %s - Adding channel %s and dialed channel %s to bridge %s",
      channel.id, channel.id, dialed.id, bridge.id);

    bridge.addChannel({
      channel: [channel.id, dialed.id]
    }, err => {
      if (err) {
        throw err;
      }
    });
  };


  // rather than registering another handler, perhaps this should hook the active
  // handler provided by the call object?
  call.originatingChannel.on("StasisEnd", (event, channel) => {
    hangupDialed(channel, call.dialedChannel);
  });

  call.dialedChannel.on("ChannelDestroyed", (event, dialed) => {
    hangupOriginal(call.originatingChannel, dialed);
  });

  joinMixingBridge(call.originatingChannel, call.dialedChannel);

};


