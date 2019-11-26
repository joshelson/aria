/**************************************************************************************

    Aria Answer action
    
    Explicitly move the call to an offhook state.
    
    Note: This is not a part of the Twilio Twiml spec. It is my own addition to allow
    for somewhat finer-grained control over the call.

**************************************************************************************/

twimlActions.Answer = (command, callback) => {

  const call = command.call;
  const channel = call.channel;
  const client = call.client;
  const playback = null;
  
  console.log(`Channel ${channel.id} - Dialing: ${command.value}`);

	setTimeout(() => {
    if (call.hungup) {
      return call.terminateCall();
    } else {
    	channel.answer();
      return callback();
    }
	}, 0);    

};

