    module.exports = {
      // The directory where your filter lists are stored.
      input: {
        filters: './'
      },
      // The directory where the generated rules.json file will be placed.
      output: {
        base: './'
      },
      // Define the filter list to be processed.
      // The 'path' is relative to the 'input' directory.
      filterLists: [
        {
          id: 'easylist',
          path: 'easylist.txt',
          enabled: true,
          type: 'dnr', // Tells the tool to generate declarativeNetRequest rules
        },
      ],
      // Tells the tool to generate the main manifest file for the rules.
      manifest: {
        id: 'easylist_ruleset'
      },
      // Tells the tool to use a single file for all rules.
      singleFile: true,
    };
    
