// Rocksmith gear and initial values from the bundled default tones.
// Keep the original device and parameter keys for native CDLC export.
export const SOUND_BASES = {
  "clean": {
    "GearList": {
      "Rack1": {
        "Type": "Racks",
        "KnobValues": {
          "Rack_StudioEQ_BassFreq": 270,
          "Rack_StudioEQ_HiMidFreq": 2,
          "Rack_StudioEQ_TrebleFreq": 5.6,
          "Rack_StudioEQ_LoMidFreq": 210,
          "Rack_StudioEQ_Treble": 3,
          "Rack_StudioEQ_LoMidQ": 1,
          "Rack_StudioEQ_Bass": 1,
          "Rack_StudioEQ_HiMid": 2,
          "Rack_StudioEQ_LoMid": 0,
          "Rack_StudioEQ_HiMidQ": 0
        },
        "Key": "Rack_StudioEQ"
      },
      "Amp": {
        "Type": "Amps",
        "KnobValues": {
          "Amp_MarshallPlexi_Loudness1": 18,
          "Amp_MarshallPlexi_Loudness2": 42,
          "Amp_MarshallPlexi_Mid": 55,
          "Amp_MarshallPlexi_Bass": 50,
          "Amp_MarshallPlexi_Pres": 20,
          "Amp_MarshallPlexi_Treble": 60
        },
        "Key": "Amp_MarshallPlexi"
      },
      "Cabinet": {
        "Type": "Cabinets",
        "KnobValues": {},
        "Key": "Cab_Marshall1960TV_Ribbon_Cone"
      }
    },
    "ToneDescriptors": [
      "$[35720]CLEAN"
    ],
    "NameSeparator": " - ",
    "Volume": "0.0",
    "Key": "Default_Clean",
    "Name": "Clean"
  },
  "crunch": {
    "GearList": {
      "Rack1": {
        "Type": "Racks",
        "KnobValues": {
          "Rack_StudioEQ_BassFreq": 270,
          "Rack_StudioEQ_HiMidFreq": 2,
          "Rack_StudioEQ_TrebleFreq": 5.6,
          "Rack_StudioEQ_LoMidFreq": 210,
          "Rack_StudioEQ_Treble": 4,
          "Rack_StudioEQ_LoMidQ": 1,
          "Rack_StudioEQ_Bass": 1,
          "Rack_StudioEQ_HiMid": 3,
          "Rack_StudioEQ_LoMid": 1,
          "Rack_StudioEQ_HiMidQ": 0
        },
        "Key": "Rack_StudioEQ"
      },
      "Amp": {
        "Type": "Amps",
        "KnobValues": {
          "Amp_MarshallPlexi_Loudness1": 40,
          "Amp_MarshallPlexi_Loudness2": 52,
          "Amp_MarshallPlexi_Mid": 68,
          "Amp_MarshallPlexi_Bass": 56,
          "Amp_MarshallPlexi_Pres": 15,
          "Amp_MarshallPlexi_Treble": 66
        },
        "Key": "Amp_MarshallPlexi"
      },
      "Cabinet": {
        "Type": "Cabinets",
        "KnobValues": {},
        "Key": "Cab_Marshall1960TV_Ribbon_Cone"
      }
    },
    "ToneDescriptors": [
      "$[27156]CRUNCH"
    ],
    "NameSeparator": " - ",
    "Volume": "0.0",
    "Key": "Default_Crunch",
    "Name": "Crunch"
  },
  "lead": {
    "GearList": {
      "Rack1": {
        "Type": "Racks",
        "KnobValues": {
          "Rack_StudioEQ_BassFreq": 270,
          "Rack_StudioEQ_HiMidFreq": 2,
          "Rack_StudioEQ_TrebleFreq": 5.6,
          "Rack_StudioEQ_LoMidFreq": 210,
          "Rack_StudioEQ_Treble": 5,
          "Rack_StudioEQ_LoMidQ": 1,
          "Rack_StudioEQ_Bass": 2,
          "Rack_StudioEQ_HiMid": 6,
          "Rack_StudioEQ_LoMid": -5,
          "Rack_StudioEQ_HiMidQ": 0
        },
        "Key": "Rack_StudioEQ"
      },
      "Rack2": {
        "Type": "Racks",
        "KnobValues": {
          "Rack_StudioChamber_Mix": 16,
          "Rack_StudioChamber_Depth": 72,
          "Rack_StudioChamber_Tone": 26,
          "Rack_StudioChamber_Time": 56
        },
        "Key": "Rack_StudioChamber",
        "Category": "Reverb"
      },
      "Amp": {
        "Type": "Amps",
        "KnobValues": {
          "Amp_MarshallPlexi_Loudness1": 88,
          "Amp_MarshallPlexi_Loudness2": 59,
          "Amp_MarshallPlexi_Mid": 85,
          "Amp_MarshallPlexi_Bass": 82,
          "Amp_MarshallPlexi_Pres": 10,
          "Amp_MarshallPlexi_Treble": 89
        },
        "Key": "Amp_MarshallPlexi"
      },
      "Cabinet": {
        "Type": "Cabinets",
        "KnobValues": {},
        "Key": "Cab_Marshall1960TV_Ribbon_Cone"
      },
      "PostPedal1": {
        "Type": "Pedals",
        "KnobValues": {
          "Pedal_ModDelay_Time": 360,
          "Pedal_ModDelay_Mix": 41,
          "Pedal_ModDelay_Feedback": 24,
          "Pedal_ModDelay_Rate": 0.5,
          "Pedal_ModDelay_Depth": 38
        },
        "Key": "Pedal_ModDelay",
        "Category": "30779"
      },
      "PrePedal1": {
        "Type": "Pedals",
        "KnobValues": {
          "Pedal_GermaniumDrive_Gain": 80,
          "Pedal_GermaniumDrive_Tone": 36
        },
        "Key": "Pedal_GermaniumDrive",
        "Category": "Distortion"
      }
    },
    "ToneDescriptors": [
      "$[35724]LEAD"
    ],
    "NameSeparator": " - ",
    "Volume": "0.0",
    "Key": "Default_Lead",
    "Name": "Lead"
  },
  "bass": {
    "GearList": {
      "Rack1": {
        "Type": "Racks",
        "KnobValues": {
          "Rack_StudioCompressor_Attack": 30,
          "Rack_StudioCompressor_Threshold": -12.5,
          "Rack_StudioCompressor_Release": 90,
          "Rack_StudioCompressor_Ratio": 3
        },
        "Key": "Rack_StudioCompressor"
      },
      "Amp": {
        "Type": "Amps",
        "KnobValues": {
          "Bass_Amp_EdenWT550_Bass": 2,
          "Bass_Amp_EdenWT550_Mid": 4,
          "Bass_Amp_EdenWT550_LoFreq": 300,
          "Bass_Amp_EdenWT550_HiFreq": 2.6,
          "Bass_Amp_EdenWT550_Lo": -4,
          "Bass_Amp_EdenWT550_Hi": -2,
          "Bass_Amp_EdenWT550_MidFreq": 1200,
          "Bass_Amp_EdenWT550_Treble": 8,
          "Bass_Amp_EdenWT550_Enhance": 49,
          "Bass_Amp_EdenWT550_Gain": 14
        },
        "Key": "Bass_Amp_EdenWT550"
      },
      "Cabinet": {
        "Type": "Cabinets",
        "KnobValues": {},
        "Key": "Bass_Cab_EdenD610XST_Condenser_Edge"
      },
      "PostPedal1": {
        "Type": "Pedals",
        "KnobValues": {
          "Bass_Pedal_MBComp_Filter": 450,
          "Bass_Pedal_MBComp_Compress": 28,
          "Bass_Pedal_MBComp_Rate": 97
        },
        "Key": "Bass_Pedal_MBComp"
      },
      "PrePedal1": {
        "Type": "Pedals",
        "KnobValues": {
          "Bass_Pedal_EdenWTDI_LoShift": 1,
          "Bass_Pedal_EdenWTDI_MidShift": 0,
          "Bass_Pedal_EdenWTDI_Gain": 18,
          "Bass_Pedal_EdenWTDI_Enhance": 1,
          "Bass_Pedal_EdenWTDI_Bass": 3,
          "Bass_Pedal_EdenWTDI_Treble": 3,
          "Bass_Pedal_EdenWTDI_Compression": 0,
          "Bass_Pedal_EdenWTDI_Mid": 4
        },
        "Key": "Bass_Pedal_EdenWTDI"
      }
    },
    "ToneDescriptors": [
      "$[35715]BASS"
    ],
    "NameSeparator": " - ",
    "Volume": "-12.0",
    "Key": "Default_Bass",
    "Name": "Bass"
  }
};
