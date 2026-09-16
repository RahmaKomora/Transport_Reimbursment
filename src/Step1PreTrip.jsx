import React, { useState } from 'react';

// Define modes of transport with assigned rates per kilometer (in KSH)
const TRANSPORT_MODES = [
  { id: 'matatu', name: 'Matatu', rate: 15, icon: '🚐' },
  { id: 'boda', name: 'Boda / Piki (Public)', rate: 20, icon: '🏍️' },
  { id: 'personal_piki', name: 'Personal Piki', rate: 25, icon: '🛵' },
  { id: 'personal_car', name: 'Personal Car', rate: 45, icon: '🚗' },
];

const TRIP_REASONS = [
  'Client Site Visit',
  'Field Audit / Operations',
  'Inter-Office Travel',
  'Vendor Meeting',
  'Emergency Response',
];

export default function Step1PreTrip({ onNext }) {
  const [reason, setReason] = useState('');
  const [comments, setComments] = useState('');
  const [selectedMode, setSelectedMode] = useState(null);

  // Validate that all fields are completed before moving forward
  const isFormValid = reason !== '' && comments.trim() !== '' && selectedMode !== null;

  const handleNext = () => {
    if (!isFormValid) return;
    
    // Pass collected pre-trip data to parent state / Step 2
    onNext({
      tripReason: reason,
      purposeComments: comments,
      transportMode: selectedMode.id,
      transportModeName: selectedMode.name,
      ratePerKm: selectedMode.rate,
    });
  };

  return (
    <div className="max-w-2xl mx-auto bg-white p-6 md:p-8 rounded-xl shadow-md border border-gray-100">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800">Start New Field Trip</h2>
        <p className="text-sm text-gray-500">Step 1 of 3: Trip Details & Transport Mode</p>
      </div>

      <div className="space-y-6">
        {/* 1. Main Reason for Trip */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Main Reason for Trip <span className="text-red-500">*</span>
          </label>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none text-gray-800"
          >
            <option value="">-- Select Trip Reason --</option>
            {TRIP_REASONS.map((r, idx) => (
              <option key={idx} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        {/* 2. Purpose Comments */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Purpose Comments <span className="text-red-500">*</span>
          </label>
          <textarea
            rows="3"
            placeholder="Provide brief context or background for this trip..."
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none text-gray-800 resize-none"
          ></textarea>
        </div>

        {/* 3. Mode of Transport Selection Cards */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-3">
            Select Mode of Transport <span className="text-red-500">*</span>
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {TRANSPORT_MODES.map((mode) => {
              const isSelected = selectedMode?.id === mode.id;
              return (
                <div
                  key={mode.id}
                  onClick={() => setSelectedMode(mode)}
                  className={`cursor-pointer p-4 border-2 rounded-xl transition-all flex items-center justify-between ${
                    isSelected
                      ? 'border-blue-600 bg-blue-50/50 shadow-sm'
                      : 'border-gray-200 hover:border-gray-300 bg-white'
                  }`}
                >
                  <div className="flex items-center space-x-3">
                    <span className="text-3xl">{mode.icon}</span>
                    <div>
                      <h4 className="font-semibold text-gray-800">{mode.name}</h4>
                      <p className="text-xs text-gray-500">Rate: KSH {mode.rate} / KM</p>
                    </div>
                  </div>
                  <input
                    type="radio"
                    name="transport_mode"
                    checked={isSelected}
                    onChange={() => {}}
                    className="h-4 w-4 text-blue-600 border-gray-300 focus:ring-blue-500"
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* Rate Banner */}
        {selectedMode && (
          <div className="bg-blue-50 border border-blue-200 p-4 rounded-lg flex justify-between items-center">
            <span className="text-sm text-blue-800 font-medium">Applied Travel Rate:</span>
            <span className="text-lg font-bold text-blue-900">
              KSH {selectedMode.rate}.00 / KM
            </span>
          </div>
        )}

        {/* Action Button */}
        <button
          onClick={handleNext}
          disabled={!isFormValid}
          className={`w-full py-3 px-6 rounded-lg font-semibold transition-colors ${
            isFormValid
              ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-md'
              : 'bg-gray-200 text-gray-400 cursor-not-allowed'
          }`}
        >
          Proceed to Location Tracking →
        </button>
      </div>
    </div>
  );
}