/**************************************************************************************

    Aria Hangup action
    
    End a call.

**************************************************************************************/
twimlActions.Hangup = (command, callback) => {

  var call = command.call;
  var channel = call.channel;
  var client = call.client;
  var playback = null;

  console.log(`Channel ${channel.id} - Hangup`);

  // terminate the call on the next tick
  setTimeout(() => {
    call.hungup = true;
    channel.hangup();
    return call.terminateCall();
  }, 0);

};

