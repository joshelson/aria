/**************************************************************************************

    Aria Message action
    
    Send a message to a Respoke endpoint.

    NOT YET IMPLEMENTED
    
**************************************************************************************/
twimlActions.Message = (command, callback) => {

  var call = command.call;
  var channel = call.channel;
  var client = call.client;
  var playback = null;

  console.log(`Channel ${channel.id} - Message: ${command.value} NOT YET IMPLEMENTED`);
  
  // TODO: implement Respoke message send
  
  // go on to the next action
  setTimeout(() => callback(), 0);

};

